/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";

/**
 * Write a file so that a reader never sees a half-written one.
 *
 * The content is staged to a sibling temp file and then renamed over the
 * target. Rename is atomic on the same filesystem, so a crash, a signal, or
 * a second writer mid-way leaves either the old file or the new one, never a
 * truncated mix. The session store and the config store both hold secrets
 * and are both written by more than one process, which is why they use this.
 *
 * On Windows a rename can fail transiently while antivirus or an indexer
 * holds the target open, so those errors are retried a few times.
 */

const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;
const RENAME_BASE_DELAY_MS = 50;

export interface AtomicWriteOptions {
  mode?: number;
  /** Injection seam for tests. */
  renameImpl?: (from: string, to: string) => Promise<void>;
  /** Injection seam for tests. */
  sleep?: (ms: number) => Promise<void>;
}

function tempPathFor(target: string): string {
  return `${target}.tmp-${randomBytes(6).toString("hex")}`;
}

function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  return TRANSIENT_RENAME_ERRORS.has(code);
}

export async function writeFileAtomic(
  target: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const {
    mode,
    renameImpl = (from, to) => fs.rename(from, to),
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  const tmp = tempPathFor(target);
  await fs.writeFile(tmp, data, mode === undefined ? {} : { mode });
  // writeFile's mode is subject to the umask; chmod is not.
  if (mode !== undefined && process.platform !== "win32") {
    await fs.chmod(tmp, mode);
  }

  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await renameImpl(tmp, target);
        return;
      } catch (error) {
        if (!isTransient(error) || attempt >= RENAME_ATTEMPTS) throw error;
        await sleep(RENAME_BASE_DELAY_MS * attempt);
      }
    }
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Synchronous twin for the config store, which is written from the CLI. */
export function writeFileAtomicSync(
  target: string,
  data: string | Buffer,
  options: { mode?: number } = {}
): void {
  const { mode } = options;
  const tmp = tempPathFor(target);
  fsSync.writeFileSync(tmp, data, mode === undefined ? {} : { mode });
  if (mode !== undefined && process.platform !== "win32") {
    fsSync.chmodSync(tmp, mode);
  }

  try {
    for (let attempt = 1; ; attempt++) {
      try {
        fsSync.renameSync(tmp, target);
        return;
      } catch (error) {
        if (!isTransient(error) || attempt >= RENAME_ATTEMPTS) throw error;
        // A short synchronous pause; there is no event loop to yield to here.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_BASE_DELAY_MS * attempt);
      }
    }
  } catch (error) {
    fsSync.rmSync(tmp, { force: true });
    throw error;
  }
}
