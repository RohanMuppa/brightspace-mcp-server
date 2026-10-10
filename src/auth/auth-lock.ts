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

/**
 * The MFA challenge the lock owner's sign-in is showing, published inside the
 * lock directory so it lives and dies with the lock (see mfa-challenge.ts).
 */
export const CHALLENGE_FILE = "challenge.json";

export class AuthenticationInProgressError extends Error {
  readonly code = "AUTH_IN_PROGRESS";
  /**
   * The owner's MFA challenge, when the caller looked it up (see
   * BrowserAuth.authenticate). Structurally `PendingChallenge` from
   * mfa-challenge.ts, spelled out here because that module imports
   * CHALLENGE_FILE from this one.
   */
  challenge?: { kind?: "automatic"; numberMatch?: string };
  constructor() {
    super("Authentication already in progress. Retry after the current authentication finishes.");
    this.name = "AuthenticationInProgressError";
  }
}

/**
 * How an owner acquired the lock: a background AuthRunner child, an explicit
 * `auth` run, or a short exclusive hold such as `auth --logout` deleting the
 * saved session. Only an explicit run ever takes over an owner, and only an
 * "automatic" one; an "exclusive" holder is never taken over, and takes over
 * no one. It is read back as "explicit" (see readOwner), which is just as
 * untouchable.
 */
type LockMode = "automatic" | "explicit" | "exclusive";

interface Owner {
  pid: number;
  host: string;
  nonce: string;
  mode: LockMode;
}

async function readOwner(lockPath: string): Promise<Owner | undefined> {
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.host === "string" && typeof owner.nonce === "string") {
      // A lock file written before `mode` existed, or one that carries an
      // unrecognized value, is treated as "explicit" — the safer default,
      // since only an "automatic" owner is ever eligible to be taken over.
      const mode: LockMode = owner.mode === "automatic" ? "automatic" : "explicit";
      return { pid: owner.pid, host: owner.host, nonce: owner.nonce, mode };
    }
  } catch {
    // An incomplete or unknown lock is not proof that its owner is gone.
  }
  return undefined;
}

function isDeadImpl(owner: Owner): boolean {
  // Session directories are local-only. DHCP can change the host's name
  // without changing this process table, so only PID liveness decides.
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Process operations behind a swappable seam. Production code always goes
 * through this object with its real implementations; a test that needs a
 * "live" owner it can safely terminate (without spawning or signaling a real
 * process) replaces `kill`/`isDead` here instead. This file is intentionally
 * free of relative imports — see tests/auth/auth-lock.test.ts, which loads it
 * standalone via a data: URL for its real-process tests, and a relative
 * import cannot be resolved from that base — so this seam is a plain
 * exported object rather than an injected logger or similar dependency.
 */
export const lockOps = {
  kill: (pid: number, signal: NodeJS.Signals): void => { process.kill(pid, signal); },
  isDead: isDeadImpl,
};

/** Remove only our fixed metadata names, after the directory was retired. */
async function cleanRetired(lockPath: string): Promise<void> {
  await fs.unlink(path.join(lockPath, "owner.json")).catch(() => {});
  await fs.unlink(path.join(lockPath, CHALLENGE_FILE)).catch(() => {});
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

export interface AcquireLockOptions {
  /**
   * Who is acquiring: a background AuthRunner child ("automatic"), an explicit
   * `auth` run ("explicit", the default), or a holder that must neither take
   * over a live sign-in nor be taken over ("exclusive").
   */
  mode?: LockMode;
}

/**
 * How long an explicit run waits, after signaling a live automatic owner,
 * for that owner to actually release the lock (either by dying outright or
 * by finishing its own cleanup and renaming the directory away) before
 * retrying acquisition.
 */
const TAKEOVER_WAIT_MS = 10_000;
const TAKEOVER_POLL_MS = 100;

/**
 * SIGTERM a live automatic owner and wait for it to actually give up the
 * lock. browser-auth.ts's `closeOnSignal` handles SIGTERM by closing the
 * browser, which makes the automatic run's in-flight MFA loop throw; its
 * `authenticate()` then runs its `finally` and releases the lock the normal
 * way (the directory is renamed away). If the child instead dies outright
 * (already-registered signal handler races the browser launch, or the
 * process is killed some other way), `isDead` catches that instead. Either
 * way this resolves once the lock is free for `acquireLease` to retry, or
 * once TAKEOVER_WAIT_MS has passed without either happening.
 */
async function waitForTakeover(lockPath: string, stale: Owner): Promise<void> {
  try {
    lockOps.kill(stale.pid, "SIGTERM");
  } catch (error) {
    // The owner exited between the liveness check and the signal. That is the
    // outcome a takeover wants; the wait below sees the dead PID and returns.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  while (Date.now() < deadline) {
    if (lockOps.isDead(stale)) return;
    const current = await readOwner(lockPath);
    if (!current || current.nonce !== stale.nonce) return;
    await delay(TAKEOVER_POLL_MS);
  }
}

/** Acquire a process-shared lock without waiting or relying on its age. */
export async function acquireProcessLock(lockPath: string, options: AcquireLockOptions = {}): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const mode = options.mode ?? "explicit";
  const lease = await acquireLease(lockPath, 0, mode);
  return () => lease.release();
}

async function acquireLease(lockPath: string, depth: number, mode: LockMode): Promise<Lease> {
  if (depth > 16) throw new AuthenticationInProgressError();
  const owner: Owner = { pid: process.pid, host: hostname(), nonce: randomUUID(), mode };
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
    if (!stale) throw new AuthenticationInProgressError();
    if (!lockOps.isDead(stale)) {
      // A live owner is not stale — the existing behavior for two contending
      // explicit runs, or an automatic run finding anything alive at all.
      // The one exception: an explicit run may take over a live *automatic*
      // one, since a background sign-in nobody is watching should not block
      // someone who just sat down to fix it in a terminal.
      if (mode !== "explicit" || stale.mode !== "automatic") throw new AuthenticationInProgressError();
      // No import of the shared logger here — see lockOps's doc comment on
      // why this file stays free of relative imports.
      console.error(`[${new Date().toISOString()}] [WARN] Took over a background sign-in (pid ${stale.pid}) for an explicit auth run`);
      await waitForTakeover(lockPath, stale);
      continue;
    }
    // Recovery gets its own process lock within the stale directory. If a
    // recovering process crashes, the same dead-owner rules recover its lock.
    // Keep this claim in the directory during rename to serialize contenders.
    const claim = await acquireLease(path.join(lockPath, "reclaim.lock"), depth + 1, mode);
    try {
      const current = await readOwner(lockPath);
      if (current?.nonce !== stale.nonce || !lockOps.isDead(current)) throw new AuthenticationInProgressError();
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
