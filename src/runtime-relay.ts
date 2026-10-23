/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { closeSync, mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
// Types only: the SDK's runtime schemas cost every chat's relay about 16 MB,
// and the runtime validates every message itself.
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { readRuntimeAddress, type RuntimeAddress } from "./shared-runtime.js";
import { log } from "./utils/logger.js";
import { startupPhase } from "./utils/startup-phase.js";

/** How long a chat waits for a runtime it started to publish its address. */
const DEFAULT_START_TIMEOUT_MS = 30_000;
/** One try, and one more on a runtime started fresh after the first could not be reached. */
const MAX_ATTEMPTS = 2;
const RUNTIME_LOG = "runtime.log";
/** The runtime log is kept across restarts until it grows past this. */
const MAX_LOG_BYTES = 1024 * 1024;

export interface RelayOptions {
  /** The shared runtime's directory (see runtimeDirectory). */
  dir: string;
  /** Start a runtime for `dir` in the background; it publishes its own address. */
  startRuntime: () => void;
  startTimeoutMs?: number;
}

/** The request never reached a runtime: try again on a fresh one. */
class Unreachable extends Error {}

/**
 * Relay one MCP client's messages to the shared runtime for `dir`, starting
 * one when none is running or the published one does not answer.
 *
 * This is what the default command does on stdio. Nothing starts until the
 * client's first message, so an editor that launches the server and never
 * uses it never starts a runtime. Each request is one POST; its reply and the
 * notifications that belong to it (an MFA challenge's progress) come back on
 * that POST's stream and go straight to this client and no other. When this
 * client goes away its requests in progress are dropped, which ends only
 * those requests in the runtime.
 */
export async function relaySharedRuntime(
  transport: Transport,
  { dir, startRuntime, startTimeoutMs = DEFAULT_START_TIMEOUT_MS }: RelayOptions,
): Promise<void> {
  const disconnected = new AbortController();
  let current: RuntimeAddress | undefined;
  let locating: Promise<RuntimeAddress> | undefined;

  /** The address to use, after `failed` (if given) did not answer. */
  const locate = (failed?: RuntimeAddress): Promise<RuntimeAddress> => {
    if (current && current.token !== failed?.token) return Promise.resolve(current);
    locating ??= (async () => {
      const published = await readRuntimeAddress(dir);
      if (published && published.token !== failed?.token) return published;
      startRuntime();
      // The runtime logs its own startup to runtime.log, which the client
      // never sees; these lines put the wait for it in the client's log.
      return startupPhase("starting the shared runtime", async () => {
        const deadline = Date.now() + startTimeoutMs;
        while (Date.now() < deadline && !disconnected.signal.aborted) {
          await delay(50);
          const started = await readRuntimeAddress(dir);
          if (started && started.token !== failed?.token) return started;
        }
        throw new Error(
          `The shared Brightspace runtime did not start within ${Math.round(startTimeoutMs / 1000)}s. ` +
          `Its log is ${path.join(dir, RUNTIME_LOG)}.`,
        );
      });
    })().then((address) => (current = address)).finally(() => { locating = undefined; });
    return locating;
  };

  const forward = async (message: JSONRPCMessage): Promise<void> => {
    const id = "method" in message && "id" in message ? message.id : undefined;
    let answered = false;
    const reply = (out: JSONRPCMessage) => {
      if (id !== undefined && "id" in out && out.id === id && !("method" in out)) answered = true;
      void transport.send(out).catch(() => {});
    };
    try {
      let failed: RuntimeAddress | undefined;
      for (let attempt = 1; ; attempt += 1) {
        const address = await locate(failed);
        try {
          await post(address, message, disconnected.signal, reply);
          if (id !== undefined && !answered) throw new Error("the runtime ended the call without answering it");
          return;
        } catch (error) {
          if (!(error instanceof Unreachable) || attempt >= MAX_ATTEMPTS) throw error;
          log("INFO", `Shared runtime did not answer (${error.message}); starting a fresh one`);
          failed = address;
        }
      }
    } catch (error) {
      if (disconnected.signal.aborted) return;
      log("ERROR", "Relaying to the shared runtime failed", error);
      if (id !== undefined && !answered) reply(failure(id, error));
    }
  };

  transport.onmessage = (message) => { void forward(message); };
  transport.onclose = () => disconnected.abort();
  await transport.start();
}

function failure(id: RequestId, error: unknown): JSONRPCMessage {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32603, message: `Could not reach the shared Brightspace runtime: ${reason}` },
  };
}

/**
 * POST one message and hand every message that comes back to `reply`.
 * Throws Unreachable when the runtime never took the request: nothing
 * listening, shutting down (503), or a different runtime now holding the
 * address (401, a token from a runtime that has since been replaced).
 */
async function post(
  address: RuntimeAddress,
  message: JSONRPCMessage,
  signal: AbortSignal,
  reply: (message: JSONRPCMessage) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(address.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${address.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(message),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Unreachable(error instanceof Error ? String((error.cause as Error | undefined)?.message ?? error.message) : String(error));
  }
  if (response.status === 503 || response.status === 401) {
    await response.body?.cancel();
    throw new Unreachable(`HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  if (response.status === 202 || !response.body) return;

  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    const body: unknown = JSON.parse(await response.text());
    for (const item of Array.isArray(body) ? body : [body]) reply(item as JSONRPCMessage);
    return;
  }
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    const { events, rest } = splitEvents(buffered);
    buffered = rest;
    for (const data of events) reply(JSON.parse(data) as JSONRPCMessage);
  }
}

/**
 * The complete server-sent events in `buffered`, as the joined text of each
 * event's `data:` lines, and whatever incomplete event is left over. Events
 * with no data (comments, priming events) are dropped.
 */
function splitEvents(buffered: string): { events: string[]; rest: string } {
  const blocks = buffered.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  const events = blocks
    .map((block) => block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n"))
    .filter((data) => data.length > 0);
  return { events, rest };
}

/**
 * Start `brightspace-mcp-server runtime <dir>` detached, so it outlives the
 * chat that started it and serves every other one. Its log goes to
 * runtime.log in `dir`, since no MCP client is listening to its stderr.
 */
export function spawnSharedRuntime(entry: string, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logFile = path.join(dir, RUNTIME_LOG);
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) truncateSync(logFile);
  } catch {
    // No log yet.
  }
  const logFd = openSync(logFile, "a", 0o600);
  // The runtime outlives the chat that started it, so it runs in its own
  // directory: Windows will not delete or rename a folder that a live process
  // is working in, and that chat's project folder would stay locked until the
  // runtime idled out. The settings it needs, .env included, are already in
  // this process's environment; a relative session directory is pinned to
  // where this chat resolved it.
  const env = { ...process.env };
  const sessionDir = env.D2L_SESSION_DIR;
  if (sessionDir && !sessionDir.startsWith("~") && !path.isAbsolute(sessionDir)) env.D2L_SESSION_DIR = path.resolve(sessionDir);
  try {
    const child = spawn(process.execPath, [entry, "runtime", path.resolve(dir)], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", "ignore", logFd],
      env,
      windowsHide: true,
    });
    child.once("error", (error) => log("ERROR", "Could not start the shared runtime", error));
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

/**
 * The relay's side of stdio: one JSON-RPC message per line, as the MCP stdio
 * transport frames them. The SDK's own transport validates every message
 * with its schemas, which is the memory the relay exists to save; a line that
 * is not JSON is dropped, since the runtime would reject it anyway.
 */
export function stdioLines(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Transport {
  const transport: Transport = {
    async start() {
      const lines = createInterface({ input });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        let message: JSONRPCMessage;
        try {
          message = JSON.parse(line) as JSONRPCMessage;
        } catch {
          return;
        }
        transport.onmessage?.(message);
      });
      lines.once("close", () => transport.onclose?.());
    },
    async send(message) {
      output.write(JSON.stringify(message) + "\n");
    },
    async close() {
      transport.onclose?.();
    },
  };
  return transport;
}
