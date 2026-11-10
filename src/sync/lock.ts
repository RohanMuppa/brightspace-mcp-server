/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * One sync at a time per destination: two running together would plan the
 * same names and race each other's writes and manifest.
 */

import { randomBytes } from "node:crypto";
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

const alreadyRunning = (pid?: unknown): SyncInputError =>
  new SyncInputError(
    `Another sync into this folder is already running${typeof pid === "number" ? ` (process ${pid})` : ""}. Wait for it to finish, or choose a different folder.`,
  );

/** Whether a lock file's content is a dead or too old owner's (an unreadable one counts as dead), and its pid. */
function judge(content: string, now: number): { stale: boolean; pid?: unknown } {
  let held: { pid?: unknown; startedAt?: unknown } = {};
  try {
    held = JSON.parse(content);
  } catch {
    // Unreadable or half-written: judged like a dead owner's.
  }
  const age = typeof held.startedAt === "number" ? now - held.startedAt : Infinity;
  // A start time in the future is a damaged or planted lock, not a fresh one: never stale-proof.
  return { stale: !(alive(held.pid) && age >= 0 && age < STALE_LOCK_MS), pid: held.pid };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** A takeover in progress that has outlived this is a process that died inside it. */
const TAKEOVER_STALE_MS = 30_000;

/**
 * Take the destination's lock, or throw a SyncInputError saying who holds it.
 * Returns the release function.
 *
 * The lock carries a random token, and release removes the file only while it
 * still holds ours. A stale lock is removed only by the one process holding
 * the short-lived takeover guard, which re-reads the lock first and leaves a
 * live one alone, so two processes cannot both discard it and both believe
 * they hold the lock.
 */
export async function acquireSyncLock(root: string, now: () => number = Date.now): Promise<() => Promise<void>> {
  const file = path.join(root, LOCK_NAME);
  const guard = `${file}.takeover`;
  const token = randomBytes(12).toString("hex");
  const body = JSON.stringify({ pid: process.pid, startedAt: now(), token });

  const create = async (): Promise<(() => Promise<void>) | null> => {
    try {
      await fs.writeFile(file, body, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    return async () => {
      try {
        if (JSON.parse(await fs.readFile(file, "utf8")).token === token) await fs.rm(file, { force: true });
      } catch {
        // Already gone, or someone else's now: not ours to remove.
      }
    };
  };

  for (let attempt = 0; attempt < 60; attempt++) {
    const release = await create();
    if (release) return release;

    let judged: string;
    try {
      judged = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // released meanwhile: try to create it
      throw error;
    }
    const verdict = judge(judged, now());
    if (!verdict.stale) throw alreadyRunning(verdict.pid);

    // Stale: only the holder of the guard may remove it.
    try {
      await fs.writeFile(guard, token, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const guardStat = await fs.stat(guard).catch(() => null);
      if (guardStat && now() - guardStat.mtimeMs > TAKEOVER_STALE_MS) await fs.rm(guard, { force: true });
      else await pause(25);
      continue;
    }
    try {
      const again = await fs.readFile(file, "utf8").catch(() => null);
      if (again !== null) {
        const recheck = judge(again, now());
        if (!recheck.stale) throw alreadyRunning(recheck.pid);
        await fs.rm(file, { force: true });
      }
    } finally {
      await fs.rm(guard, { force: true });
    }
  }
  throw alreadyRunning();
}
