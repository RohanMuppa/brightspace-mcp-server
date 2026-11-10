/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * One sync at a time per destination: two running together would plan the
 * same names and race each other's writes and manifest.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { LOCK_NAME } from "./manifest.js";
import { SyncInputError } from "./errors.js";

/** A lock older than this is a sync that died without cleaning up. */
export const STALE_LOCK_MS = 60 * 60 * 1000;

function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take the destination's lock, or throw a SyncInputError saying who holds it. Returns the release function. */
export async function acquireSyncLock(root: string, now: () => number = Date.now): Promise<() => Promise<void>> {
  const file = path.join(root, LOCK_NAME);
  const body = JSON.stringify({ pid: process.pid, startedAt: now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(file, body, { flag: "wx" });
      return async () => {
        await fs.rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let held: { pid?: unknown; startedAt?: unknown } = {};
    try {
      held = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      // Unreadable or half-written: judged by the checks below like a dead owner's.
    }
    const age = typeof held.startedAt === "number" ? now() - held.startedAt : Infinity;
    if (alive(held.pid) && age < STALE_LOCK_MS) {
      throw new SyncInputError(
        `Another sync into this folder is already running (process ${held.pid}). Wait for it to finish, or choose a different folder.`,
      );
    }
    await fs.rm(file, { force: true });
  }
  throw new SyncInputError("Another sync into this folder is already running. Wait for it to finish, or choose a different folder.");
}
