import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { acquireProcessLock } from "../../src/auth/auth-lock.js";
import { authLockPath } from "../../src/auth/mfa-challenge.js";
import { isAutomaticSignInCommand, stopAutomaticSignIn } from "../../src/auth/auth-runner.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ log: vi.fn() }));

/**
 * sign_out and `auth --logout` stop a background sign-in another app started,
 * reading its PID from the lock file. The PID is only trusted when ps shows
 * this package's sign-in child, so a reused PID is never killed.
 */

describe("isAutomaticSignInCommand", () => {
  it.each([
    "/opt/homebrew/bin/node /Users/me/My Projects/node_modules/brightspace-mcp-server/build/auth-cli.js --automatic",
    "node C:\\Users\\me\\brightspace\\build\\auth-cli.js --automatic",
    // An app may run the server on an embedded runtime that isn't named node.
    "/Applications/Some App.app/Contents/MacOS/Some App Helper /x/build/auth-cli.js --automatic",
  ])("accepts the sign-in child: %s", (command) => {
    expect(isAutomaticSignInCommand(command)).toBe(true);
  });

  it.each([
    "node /x/xauth-cli.js --automatic",
    "node /x/auth-cli.jsx --automatic",
    "node /x/auth-cli.js --automatic-mode",
    "node /x/auth-cli.js",
    "node /x/auth-cli.js --logout",
    "node /x/other.js --automatic auth-cli.js",
  ])("rejects anything else: %s", (command) => {
    expect(isAutomaticSignInCommand(command)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("stopAutomaticSignIn", () => {
  let dir: string;
  let release: (() => Promise<void>) | undefined;
  let signals: Array<[number, NodeJS.Signals | number | undefined]>;
  /** What `kill(pid, 0)` reports once SIGKILL was sent: exited, or a live process this user can't signal. */
  let afterKill: "ESRCH" | "EPERM";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "stop-automatic-"));
    signals = [];
    afterKill = "ESRCH";
    // Never signals a real process: the lock's owner PID is this test's own.
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      signals.push([pid, signal]);
      const killed = signals.some(([, s]) => s === "SIGKILL");
      if (signal === 0 && killed) throw Object.assign(new Error(`kill ${afterKill}`), { code: afterKill });
      return true;
    }) as typeof process.kill);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await release?.();
    release = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const psShows = (command: string) =>
    vi.mocked(execFileSync).mockImplementation(((_file: string, args: string[]) =>
      (args.includes("command=") ? `${command}\n` : "")) as typeof execFileSync);

  it("stops a live automatic owner whose command line is the sign-in child", async () => {
    release = await acquireProcessLock(authLockPath(dir), { mode: "automatic" });
    psShows("/usr/local/bin/node /x/build/auth-cli.js --automatic");

    expect(await stopAutomaticSignIn(authLockPath(dir))).toBe(true);
    expect(signals).toContainEqual([process.pid, "SIGKILL"]);
  });

  it("kills nothing when the PID now belongs to another program", async () => {
    release = await acquireProcessLock(authLockPath(dir), { mode: "automatic" });
    psShows("/usr/bin/vim /tmp/notes-about-xauth-cli.js --automatic-mode");

    expect(await stopAutomaticSignIn(authLockPath(dir))).toBe(false);
    expect(signals.some(([, s]) => s === "SIGKILL")).toBe(false);
  });

  it("never stops a person's `auth` run, and does not even look it up", async () => {
    release = await acquireProcessLock(authLockPath(dir));
    psShows("/usr/local/bin/node /x/build/auth-cli.js --automatic");

    expect(await stopAutomaticSignIn(authLockPath(dir))).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(signals.some(([, s]) => s === "SIGKILL")).toBe(false);
  });

  // Real time: it waits out the whole 5-second cancel window.
  it("does not report a process it could not signal (EPERM) as stopped", { timeout: 15_000 }, async () => {
    release = await acquireProcessLock(authLockPath(dir), { mode: "automatic" });
    psShows("/usr/local/bin/node /x/build/auth-cli.js --automatic");
    afterKill = "EPERM";

    expect(await stopAutomaticSignIn(authLockPath(dir))).toBe(false);
  });

  it("does nothing when no sign-in holds the lock", async () => {
    expect(await stopAutomaticSignIn(authLockPath(dir))).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
