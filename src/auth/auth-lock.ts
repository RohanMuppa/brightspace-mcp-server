import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Windows refuses to rename or remove a directory while any process still
 * holds a handle inside it. Every contender for a stale lock is doing exactly
 * that: reclaim.lock lives inside the directory the winner is trying to rename,
 * so the loser's own scan blocks the winner. POSIX renames by inode and never
 * sees this.
 *
 * The condition clears in milliseconds, so a short retry turns a spurious
 * EPERM into an ordinary release instead of an unhandled crash.
 */
const CONTENTION_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
const RENAME_ATTEMPTS = 5;

/**
 * Rename, tolerating Windows contention. Resolves true when the directory
 * moved, false when it is already gone or contention never cleared. Only a
 * genuinely unexpected error is thrown, so callers decide what a failed
 * rename means rather than being handed an ambiguous EPERM.
 */
async function renameThroughContention(from: string, to: string): Promise<boolean> {
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(from, to);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") return false;
      if (!CONTENTION_CODES.has(code)) throw error;
      await delay(10 * (attempt + 1));
    }
  }
  return false;
}

export class AuthenticationInProgressError extends Error {
  readonly code = "AUTH_IN_PROGRESS";
  constructor() {
    super("Authentication already in progress. Retry after the current authentication finishes.");
    this.name = "AuthenticationInProgressError";
  }
}

interface Owner {
  pid: number;
  host: string;
  nonce: string;
}

async function readOwner(lockPath: string): Promise<Owner | undefined> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.host === "string" && typeof owner.nonce === "string") return owner;
  } catch {
    // An incomplete or unknown lock is not proof that its owner is gone.
  }
  return undefined;
}

function isDead(owner: Owner): boolean {
  // Session directories are local-only. DHCP can change the host's name
  // without changing this process table, so only PID liveness decides.
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Remove only our fixed metadata names, after the directory was retired. */
async function cleanRetired(lockPath: string): Promise<void> {
  await fs.unlink(path.join(lockPath, "owner.json")).catch(() => {});
  await cleanChild(path.join(lockPath, "reclaim.lock"));
  await fs.rmdir(lockPath).catch(() => {});
}
async function cleanChild(childPath: string): Promise<void> {
  try {
    if ((await fs.lstat(childPath)).isDirectory()) await cleanRetired(childPath);
  } catch { /* Already absent. */ }
}

class Lease {
  constructor(public directory: string, readonly owner: Owner) {}
  async release(): Promise<void> {
    const current = await readOwner(this.directory);
    if (current?.nonce !== this.owner.nonce) return;
    const retired = `${this.directory}.released.${this.owner.nonce}`;
    // Releasing must never throw. It runs in a finally, so an exception here
    // would mask the real failure and strand the lock for everyone else.
    if (await renameThroughContention(this.directory, retired)) {
      await cleanRetired(retired);
      return;
    }
    // Contention never cleared. Clear the directory where it stands so the
    // next process sees no owner rather than a lock nobody holds.
    await cleanRetired(this.directory);
  }
}

/** Acquire a process-shared lock without waiting or relying on its age. */
export async function acquireProcessLock(lockPath: string): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const lease = await acquireLease(lockPath, 0);
  return () => lease.release();
}

async function acquireLease(lockPath: string, depth: number): Promise<Lease> {
  if (depth > 16) throw new AuthenticationInProgressError();
  const owner: Owner = { pid: process.pid, host: hostname(), nonce: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
      } catch (error) {
        await fs.rmdir(lockPath).catch(() => {});
        throw error;
      }
      return new Lease(lockPath, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AuthenticationInProgressError();
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const stale = await readOwner(lockPath);
    if (!stale || !isDead(stale)) throw new AuthenticationInProgressError();
    // Recovery gets its own process lock within the stale directory. If a
    // recovering process crashes, the same dead-owner rules recover its lock.
    // Keep this claim in the directory during rename to serialize contenders.
    const claim = await acquireLease(path.join(lockPath, "reclaim.lock"), depth + 1);
    try {
      const current = await readOwner(lockPath);
      if (current?.nonce !== stale.nonce || !isDead(current)) throw new AuthenticationInProgressError();
      const retired = `${lockPath}.stale.${owner.nonce}`;
      // A rename blocked by contention means another contender is inside this
      // directory recovering the same stale lock. That is someone else holding
      // authentication, not a failure of ours.
      if (!await renameThroughContention(lockPath, retired)) {
        throw new AuthenticationInProgressError();
      }
      claim.directory = path.join(retired, "reclaim.lock");
      await claim.release();
      await cleanRetired(retired);
    } finally {
      await claim.release();
    }
  }
  throw new AuthenticationInProgressError();
}
