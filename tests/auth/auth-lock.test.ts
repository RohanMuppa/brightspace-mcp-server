import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import ts from "typescript";
import { acquireProcessLock, AuthenticationInProgressError, lockOps } from "../../src/auth/auth-lock.js";

let lockPath: string;
let moduleUrl: string;

beforeEach(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-lock-test-"));
  lockPath = path.join(directory, "auth.lock");
  const source = await fs.readFile(new URL("../../src/auth/auth-lock.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
});

// A winning child holds the lock until its stdin receives data, so the hold
// never depends on how long the other contenders take to start.
function child(): ChildProcessWithoutNullStreams {
  const script = `
    const { acquireProcessLock } = await import(process.argv[1]);
    try {
      const release = await acquireProcessLock(process.argv[2]);
      process.stdout.write("locked\\n");
      process.stdin.once("data", async () => { await release(); process.exit(0); });
    } catch (error) { process.stdout.write(error.code + "\\n"); process.exitCode = 2; }
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script, moduleUrl, lockPath], { stdio: "pipe" });
}

async function firstLine(process: ChildProcessWithoutNullStreams): Promise<string> {
  const [data] = await once(process.stdout, "data");
  return String(data).trim();
}

// Starts four contenders at once and returns each one's acquisition result.
// Winners are released only after every result is in, so a slow-starting
// contender always meets a held lock.
async function contend(): Promise<string[]> {
  const processes = Array.from({ length: 4 }, () => child());
  const exits = processes.map(process => once(process, "exit"));
  const messages = await Promise.all(processes.map(firstLine));
  processes.forEach((process, index) => { if (messages[index] === "locked") process.stdin.write("release\n"); });
  await Promise.all(exits);
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
    const messages = await contend();
    expect(messages.filter(message => message === "locked")).toHaveLength(1);
    expect(messages.filter(message => message === "AUTH_IN_PROGRESS")).toHaveLength(3);
  });

  it("recovers a lock after its actual process dies", async () => {
    const owner = child();
    const exit = once(owner, "exit");
    expect(await firstLine(owner)).toBe("locked");
    owner.kill("SIGKILL");
    await exit;
    const ownerFile = path.join(lockPath, "owner.json");
    const metadata = JSON.parse(await fs.readFile(ownerFile, "utf8"));
    await fs.writeFile(ownerFile, JSON.stringify({ ...metadata, host: "previous-dhcp-hostname" }));
    await (await acquireProcessLock(lockPath))();
  });

  it("serializes competing processes recovering a dead owner", async () => {
    const owner = child();
    const exit = once(owner, "exit");
    expect(await firstLine(owner)).toBe("locked");
    owner.kill("SIGKILL");
    await exit;
    const messages = await contend();
    expect(messages.filter(message => message === "locked")).toHaveLength(1);
    expect(messages.filter(message => message === "AUTH_IN_PROGRESS")).toHaveLength(3);
  });

  it("recovers when a stale-recovery process also died", async () => {
    const owner = child();
    const exit = once(owner, "exit");
    expect(await firstLine(owner)).toBe("locked");
    owner.kill("SIGKILL");
    await exit;
    const metadata = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");
    const claimPath = path.join(lockPath, "reclaim.lock");
    await fs.mkdir(claimPath);
    await fs.writeFile(path.join(claimPath, "owner.json"), metadata);
    await (await acquireProcessLock(lockPath))();
  });
});

describe("explicit takeover of a live automatic owner", () => {
  afterEach(() => vi.restoreAllMocks());

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
