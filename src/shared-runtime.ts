/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireProcessLock, AuthenticationInProgressError } from "./auth/auth-lock.js";
import type { RunningHttpServer } from "./http-server.js";
import type { ServerRuntime } from "./server.js";
import type { AppConfig } from "./types/index.js";
import { writeFileAtomic, type AtomicWriteOptions } from "./utils/atomic-write.js";
import { log } from "./utils/logger.js";

/** How long a shared runtime waits with no request in progress before it stops. */
export const DEFAULT_IDLE_MS = 10 * 60_000;
/** How long a starting runtime waits for a runtime that is starting or stopping to settle. */
const CLAIM_WAIT_MS = 10_000;
/** How long a published runtime has to answer before it is taken for dead. */
const PROBE_TIMEOUT_MS = 2_000;
const STATE_FILE = "state.json";
const OWNER_LOCK = "owner.lock";

/** Where a running shared runtime listens, published in its state file. */
export interface RuntimeAddress {
  pid: number;
  url: string;
  token: string;
}

/**
 * The directory one shared runtime lives in: one per account (inside its
 * session directory), settings, and package version. Two chats share a
 * runtime only when they would have built the same one themselves, and an
 * upgraded package starts its own instead of talking to old code.
 *
 * The saved password and authenticator key play no part: the relay that picks
 * the runtime loads its settings without reading the credential store (see
 * loadConfig), and every sign-in reads them itself. A pasted access token or
 * cookie is a high-entropy secret and is hashed like any other setting.
 */
export function runtimeDirectory(config: AppConfig, version: string): string {
  const { password: _password, totpUri: _totpUri, legacyBrowserStateMigrated: _perRun, ...settings } = config;
  const identity = JSON.stringify({ version, settings });
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return path.join(config.sessionDir, "shared-runtime", key);
}

/** Errors that mean the file is held open for a moment (antivirus, an indexer, a replace in progress on Windows). */
const TRANSIENT_FILE_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);
const READ_ATTEMPTS = 6;
const READ_RETRY_MS = 20;

export interface ReadAddressOptions {
  /** Injection seam for tests. */
  readFile?: (file: string) => Promise<string>;
  /** Injection seam for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The published address in `dir`, or undefined when no runtime has published one.
 *
 * A file that is momentarily locked (EPERM, EBUSY, EACCES) or caught as
 * unparseable JSON is read again a few times before it counts as unreadable:
 * the runtime replaces this file while relays poll it, and a reader that
 * lost that race must look again, not take it for "no runtime". A missing
 * file, or well-formed JSON of the wrong shape, is an answer and is not retried.
 */
export async function readRuntimeAddress(
  dir: string,
  { readFile = (file) => fs.readFile(file, "utf-8"), sleep = (ms) => delay(ms) }: ReadAddressOptions = {},
): Promise<RuntimeAddress | undefined> {
  const file = path.join(dir, STATE_FILE);
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try {
      const parsed = JSON.parse(await readFile(file)) as Partial<RuntimeAddress> | null;
      if (parsed && typeof parsed.pid === "number" && typeof parsed.url === "string" && typeof parsed.token === "string") {
        return { pid: parsed.pid, url: parsed.url, token: parsed.token };
      }
      return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const retryable = error instanceof SyntaxError || TRANSIENT_FILE_ERRORS.has(code);
      if (!retryable || attempt >= READ_ATTEMPTS) return undefined;
      await sleep(READ_RETRY_MS * attempt);
    }
  }
  return undefined;
}

export interface SharedRuntime {
  address: RuntimeAddress;
  /** Resolves once the runtime has stopped and given up its directory. */
  stopped: Promise<void>;
  /** Stop now, after the calls in progress finish. */
  stop(): Promise<void>;
}

/**
 * Serve `runtime` as the one shared runtime for `dir`, or resolve undefined
 * when another runtime already serves it. Concurrent starts converge: the
 * owner lock admits one, and the rest return once its address is published.
 *
 * The winner listens on a free 127.0.0.1 port behind a fresh random bearer
 * token, publishes both in a 0600 state file, and stops after `idleMs` with
 * no request in progress. A call waiting on MFA approval is a request in
 * progress, so idleness never cuts one off. It unpublishes its address before
 * it stops listening, so a chat arriving during shutdown starts a successor
 * rather than finding a dead address.
 */
export async function serveSharedRuntime(
  runtime: ServerRuntime,
  { dir, idleMs, renameImpl, sleep }: {
    dir: string;
    idleMs: number;
    /** Injection seams for tests: how the state file is put in place. */
    renameImpl?: AtomicWriteOptions["renameImpl"];
    sleep?: AtomicWriteOptions["sleep"];
  },
): Promise<SharedRuntime | undefined> {
  const releaseLock = await claimOwnership(dir);
  if (!releaseLock) return undefined;

  const stateFile = path.join(dir, STATE_FILE);
  const token = randomBytes(32).toString("hex");
  let idleTimer: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  let server: RunningHttpServer | undefined;
  let markStopped!: () => void;
  const stopped = new Promise<void>((done) => { markStopped = done; });

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearTimeout(idleTimer);
      await fs.unlink(stateFile).catch(() => {});
      await server?.close();
      await releaseLock();
      markStopped();
    })();
    return stopping;
  };
  const onActiveChange = (active: number) => {
    clearTimeout(idleTimer);
    if (active > 0 || stopping) return;
    idleTimer = setTimeout(() => {
      log("INFO", `Shared runtime idle for ${Math.round(idleMs / 1000)}s; stopping`);
      void stop();
    }, idleMs);
  };

  try {
    // Loaded here, not at the top: the relay in every chat imports this
    // module for runtimeDirectory and must not pull in the server with it.
    const { startHttpServer } = await import("./http-server.js");
    server = await startHttpServer({ runtime, token, port: 0, onActiveChange });
    const address: RuntimeAddress = { pid: process.pid, url: server.url, token };
    // Written to a temp file and renamed over, so a reader never sees half a
    // file. On Windows the rename can fail while a relay has the file open;
    // writeFileAtomic retries that briefly, and a publish that still fails
    // throws here so the start fails with the reason instead of leaving
    // relays waiting for an address that will never appear.
    try {
      await writeFileAtomic(stateFile, JSON.stringify(address), { mode: 0o600, renameImpl, sleep });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not publish the shared runtime's address to ${stateFile}: ${reason}`, { cause: error });
    }
    onActiveChange(0);
    return { address, stopped, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Take the owner lock for `dir`, waiting out a runtime that is starting or
 * stopping. undefined when another live runtime has published its address.
 *
 * A published address that does not answer belongs to a runtime that died
 * without cleaning up, typically in a reboot, which also leaves its owner
 * lock behind. Its pid may since have gone to an unrelated process, so the
 * lock is reclaimed when its owner is that pid, not only when the pid is gone.
 * A runtime that is still starting holds the lock under its own pid and has
 * not published yet, so it is waited for instead.
 */
async function claimOwnership(dir: string): Promise<(() => Promise<void>) | undefined> {
  const deadline = Date.now() + CLAIM_WAIT_MS;
  for (;;) {
    const published = await readRuntimeAddress(dir);
    if (published && await answers(published)) return undefined;
    try {
      return await acquireProcessLock(path.join(dir, OWNER_LOCK), {
        mode: "exclusive",
        abandoned: (pid) => pid === published?.pid,
      });
    } catch (error) {
      if (!(error instanceof AuthenticationInProgressError)) throw error;
    }
    if (Date.now() > deadline) return undefined;
    await delay(50);
  }
}

/**
 * Whether the runtime at `address` is still serving it. Anything but a
 * refused or timed-out connection, or a 401 from another server now on that
 * port, counts: a runtime that is shutting down (503) is still alive.
 */
async function answers(address: RuntimeAddress): Promise<boolean> {
  try {
    const response = await fetch(address.url, {
      headers: { Authorization: `Bearer ${address.token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    // A runtime answers an authorized GET with 405 (it serves POST only). Any
    // other answer is another program that took a dead runtime's port.
    return response.status === 405;
  } catch {
    return false;
  }
}
