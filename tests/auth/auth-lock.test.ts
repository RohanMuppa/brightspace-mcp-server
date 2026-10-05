import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import ts from "typescript";
import { acquireProcessLock, AuthenticationInProgressError, lockOps } from "../../src/auth/auth-lock.js";
import { watchProcess, waitForExit, stopProcess, STARTUP_TIMEOUT_MS, EXIT_TIMEOUT_MS, type ProcessFixture } from "./process-fixture.js";

let lockPath: string;
let moduleUrl: string;
let directory: string;
interface ProcessScope { processes: ProcessFixture[]; closed: boolean }
let processScope: ProcessScope;

beforeAll(async () => {
  const source = await fs.readFile(new URL("../../src/auth/auth-lock.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
});

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-lock-test-"));
  lockPath = path.join(directory, "auth.lock");
  processScope = { processes: [], closed: false };
});

afterEach(async () => {
  processScope.closed = true;
  const cleanup = await Promise.allSettled(processScope.processes.map(stopProcess));
  vi.restoreAllMocks();
  // This is the exact directory created by mkdtemp for this test.
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  const failure = cleanup.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
});

// A winning child holds the lock until its stdin receives data, so the hold
// never depends on how long the other contenders take to start.
function child(targetLockPath: string, scope: ProcessScope): ProcessFixture {
  if (scope.closed) throw new Error("Cannot start a child after test cleanup has begun");
  const script = `
    const { acquireProcessLock } = await import(process.argv[1]);
    try {
      const release = await acquireProcessLock(process.argv[2]);
      process.stdout.write("locked\\n");
      process.stdin.once("data", async () => { await release(); process.exit(0); });
    } catch (error) { process.stdout.write(error.code + "\\n"); process.exitCode = 2; }
  `;
  const fixture = watchProcess(spawn(process.execPath, ["--input-type=module", "-e", script, moduleUrl, targetLockPath], { stdio: "pipe" }));
  scope.processes.push(fixture);
  return fixture;
}

// Starts four contenders at once and returns each one's acquisition result.
// Winners are released only after every result is in, so a slow-starting
// contender always meets a held lock.
async function contend(targetLockPath: string, scope: ProcessScope): Promise<string[]> {
  const contenders = Array.from({ length: 4 }, () => child(targetLockPath, scope));
  const messages = await Promise.all(contenders.map(process => process.ready));
  contenders.forEach((process, index) => { if (messages[index] === "locked") process.child.stdin.write("release\n"); });
  await Promise.all(contenders.map(process => waitForExit(process)));
  return messages;
}

describe("process-shared authentication lock", () => {
  it("fails quickly for a live owner and can be acquired after release", async () => {
    const release = await acquireProcessLock(lockPath);
    await expect(acquireProcessLock(lockPath)).rejects.toBeInstanceOf(AuthenticationInProgressError);
    await release();
    await (await acquireProcessLock(lockPath))();
  });

  it("does not reclaim unknown ownership or a live PID after the hostname changes", async () => {
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owner.json"), "{}");
    await expect(acquireProcessLock(lockPath)).rejects.toBeInstanceOf(AuthenticationInProgressError);
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, host: "previous-dhcp-hostname", nonce: "foreign" }));
    await expect(acquireProcessLock(lockPath)).rejects.toBeInstanceOf(AuthenticationInProgressError);
  });

  it("allows only one of four real processes to authenticate", async () => {
    const messages = await contend(lockPath, processScope);
    expect(messages.filter(message => message === "locked")).toHaveLength(1);
    expect(messages.filter(message => message === "AUTH_IN_PROGRESS")).toHaveLength(3);
  });

  it("recovers a lock after its actual process dies", async () => {
    const testLockPath = lockPath;
    const scope = processScope;
    const owner = child(testLockPath, scope);
    expect(await owner.ready).toBe("locked");
    await stopProcess(owner);
    const ownerFile = path.join(testLockPath, "owner.json");
    const metadata = JSON.parse(await fs.readFile(ownerFile, "utf8"));
    await fs.writeFile(ownerFile, JSON.stringify({ ...metadata, host: "previous-dhcp-hostname" }));
    await (await acquireProcessLock(testLockPath))();
  });

  it("serializes competing processes recovering a dead owner", async () => {
    const testLockPath = lockPath;
    const scope = processScope;
    const owner = child(testLockPath, scope);
    expect(await owner.ready).toBe("locked");
    await stopProcess(owner);
    const messages = await contend(testLockPath, scope);
    expect(messages.filter(message => message === "locked")).toHaveLength(1);
    expect(messages.filter(message => message === "AUTH_IN_PROGRESS")).toHaveLength(3);
  // Two sequential waves (owner, then contenders), each with bounded startup
  // and exit. The default 5s timed out under parallel Windows test runs.
  }, 2 * (STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS) + 1_000);

  it("recovers when a stale-recovery process also died", async () => {
    const testLockPath = lockPath;
    const scope = processScope;
    const owner = child(testLockPath, scope);
    expect(await owner.ready).toBe("locked");
    await stopProcess(owner);
    const metadata = await fs.readFile(path.join(testLockPath, "owner.json"), "utf8");
    const claimPath = path.join(testLockPath, "reclaim.lock");
    await fs.mkdir(claimPath);
    await fs.writeFile(path.join(claimPath, "owner.json"), metadata);
    await (await acquireProcessLock(testLockPath))();
  // Budget the bounded child startup and shutdown plus filesystem recovery.
  }, STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS + 1_000);
});

describe("explicit takeover of a live automatic owner", () => {
  async function writeOwner(nonce: string, pid: number, mode: "automatic" | "explicit") {
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid, host: "other-host", nonce, mode }));
  }

  it("SIGTERMs and takes over a live automatic owner for an explicit acquire", async () => {
    await writeOwner("auto-owner", 424242, "automatic");

    // Fake liveness rather than spawning a real process: kill() flips the
    // owner "dead" the moment it is called, which is also what a real SIGTERM
    // does once browser-auth.ts's closeOnSignal unwinds the child's MFA loop
    // and its `authenticate()` finally releases the lock.
    let alive = true;
    const isDead = vi.spyOn(lockOps, "isDead").mockImplementation(() => !alive);
    const kill = vi.spyOn(lockOps, "kill").mockImplementation(() => { alive = false; });

    const release = await acquireProcessLock(lockPath, { mode: "explicit" });
    expect(kill).toHaveBeenCalledWith(424242, "SIGTERM");
    expect(isDead).toHaveBeenCalled();
    await release();
  });

  it("still takes over when the automatic owner exits between the liveness check and the signal", async () => {
    await writeOwner("auto-owner-gone", 424245, "automatic");
    // process.kill on a PID that just exited throws ESRCH. That is not a
    // failure of the takeover -- the lock is about to be free -- so the
    // explicit run must proceed rather than surface an unexpected error.
    vi.spyOn(lockOps, "isDead").mockReturnValueOnce(false).mockReturnValue(true);
    vi.spyOn(lockOps, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });

    const release = await acquireProcessLock(lockPath, { mode: "explicit" });
    await release();
  });

  it("never takes over a live explicit owner", async () => {
    await writeOwner("explicit-owner", 424243, "explicit");
    vi.spyOn(lockOps, "isDead").mockReturnValue(false);
    const kill = vi.spyOn(lockOps, "kill");

    await expect(acquireProcessLock(lockPath, { mode: "explicit" })).rejects.toBeInstanceOf(AuthenticationInProgressError);
    expect(kill).not.toHaveBeenCalled();
  });

  it("never lets an automatic acquire take over anything, even a live automatic owner", async () => {
    await writeOwner("auto-owner-2", 424244, "automatic");
    vi.spyOn(lockOps, "isDead").mockReturnValue(false);
    const kill = vi.spyOn(lockOps, "kill");

    await expect(acquireProcessLock(lockPath, { mode: "automatic" })).rejects.toBeInstanceOf(AuthenticationInProgressError);
    expect(kill).not.toHaveBeenCalled();
  });
});
