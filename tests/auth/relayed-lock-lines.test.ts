import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { relayedLockLines } from "../../src/auth/mfa-challenge.js";
import { inspectLockOwner, lockOps } from "../../src/auth/auth-lock.js";

/**
 * What an automatic child prints when its sign-in finds the auth lock held.
 * Only another server's background sign-in is worth waiting on before it has
 * a challenge; anything else stays the plain "busy" it always was.
 */
describe("relayedLockLines", () => {
  it("relays the owner's number", () => {
    expect(relayedLockLines({ numberMatch: "72" }, "automatic")).toEqual(["AUTH_RELAYED", "MFA_NUMBER:72"]);
  });

  it("relays an owner answering its own code", () => {
    expect(relayedLockLines({ kind: "automatic" }, "automatic")).toEqual(["AUTH_RELAYED", "AUTH_AUTOMATIC_PENDING"]);
  });

  it("says a background owner is still starting when it has no challenge yet", () => {
    expect(relayedLockLines(undefined, "automatic")).toEqual(["AUTH_RELAYED_STARTING"]);
  });

  it("says nothing for an explicit `auth` run, which never publishes a challenge", () => {
    expect(relayedLockLines(undefined, "explicit")).toEqual([]);
  });

  it("says nothing when the owner cannot be identified, or the error came from another lock", () => {
    expect(relayedLockLines(undefined, undefined)).toEqual([]);
  });
});

describe("inspectLockOwner", () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function lockWith(owner: object | null): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "brightspace-inspect-lock-"));
    const lock = path.join(dir, ".auth.lock");
    fs.mkdirSync(lock);
    if (owner) fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner));
    return lock;
  }

  it("reports a live background owner", async () => {
    const lock = lockWith({ pid: process.pid, host: "h", nonce: "n", mode: "automatic" });
    expect(await inspectLockOwner(lock)).toEqual({ mode: "automatic", gone: false });
  });

  it("reports an exclusive holder as explicit", async () => {
    const lock = lockWith({ pid: process.pid, host: "h", nonce: "n", mode: "exclusive" });
    expect(await inspectLockOwner(lock)).toEqual({ mode: "explicit", gone: false });
  });

  it("reports a dead owner as gone", async () => {
    vi.spyOn(lockOps, "isDead").mockReturnValue(true);
    const lock = lockWith({ pid: 999999, host: "h", nonce: "n", mode: "automatic" });
    expect(await inspectLockOwner(lock)).toEqual({ mode: "automatic", gone: true });
  });

  it("knows nothing about a lock with no owner record yet", async () => {
    expect(await inspectLockOwner(lockWith(null))).toBeUndefined();
  });
});
