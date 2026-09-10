import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { AuthRunner } from "../../src/auth/auth-runner.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ log: vi.fn() }));

function mockChild() {
  return Object.assign(new EventEmitter(), {
    pid: 12345, stderr: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(),
  });
}

describe("AuthRunner", () => {
  let child: ReturnType<typeof mockChild>;
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    child = mockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(execFileSync).mockReturnValue("12345 100\n12346 12345\n12347 12346\n99999 100\n" as never);
    kill = vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("runs automatic authentication and forwards complete MFA lines", async () => {
    const progress = vi.fn();
    const runner = new AuthRunner({ onProgress: progress });
    const result = runner.run();
    child.stderr.write("MFA number: ");
    child.stderr.write("42\nWaiting for approval\n");
    child.emit("close", 0);

    expect(await result).toBe(true);
    expect(spawn).toHaveBeenCalledWith(process.execPath,
      [expect.stringContaining("auth-cli.js"), "--automatic"],
      expect.objectContaining({ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }));
    expect(progress.mock.calls).toEqual([["MFA number: 42"], ["Waiting for approval"]]);
  });

  it("joins the login already in flight instead of spawning a second child", async () => {
    const runner = new AuthRunner();
    const first = runner.run();
    const second = runner.run();

    expect(spawn).toHaveBeenCalledTimes(1);
    child.emit("close", 0);

    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });

  it("hands the same failure to every caller that joined", async () => {
    const runner = new AuthRunner();
    const first = expect(runner.run()).rejects.toMatchObject({ kind: "cooldown" });
    const second = expect(runner.run()).rejects.toMatchObject({ kind: "cooldown" });
    child.emit("close", 3);
    await Promise.all([first, second]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh login after a failed one rather than replaying it", async () => {
    const runner = new AuthRunner();
    const failed = expect(runner.run()).rejects.toMatchObject({ kind: "failed" });
    child.emit("close", 1);
    await failed;

    child = mockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const retry = runner.run();
    child.emit("close", 0);

    expect(await retry).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each([[2, "busy"], [3, "cooldown"], [4, "unsupported"], [5, "secureStorage"], [6, "transport"], [1, "failed"]])(
    "preserves child exit %s as a %s error", async (code, kind) => {
      const result = new AuthRunner().run();
      const failure = expect(result).rejects.toMatchObject({ kind });
      child.emit("close", code);
      await failure;
    },
  );

  it("allows five minutes of MFA plus preflight before timing out", async () => {
    const result = new AuthRunner().run();
    await vi.advanceTimersByTimeAsync(6 * 60000);
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 0);
    await result;
  });

  it("force-stops a hung child tree and releases its in-process lock", async () => {
    const exits = process.listenerCount("exit");
    const runner = new AuthRunner({ timeoutMs: 1000 });
    const failure = expect(runner.run()).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    if (process.platform !== "win32") expect(kill).toHaveBeenCalledWith(-child.pid, "SIGTERM");
    else expect(execFileSync).toHaveBeenCalledWith("taskkill", ["/pid", "12345", "/t", "/f"], expect.any(Object));
    await vi.advanceTimersByTimeAsync(5000);
    await failure;
    if (process.platform !== "win32") {
      expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
      expect(kill).toHaveBeenCalledWith(12346, "SIGKILL");
      expect(kill).toHaveBeenCalledWith(12347, "SIGKILL");
      expect(kill).not.toHaveBeenCalledWith(99999, expect.any(String));
    } else expect(execFileSync).toHaveBeenCalledWith("taskkill", ["/pid", "12345", "/t", "/f"], expect.any(Object));
    expect(process.listenerCount("exit")).toBe(exits);

    child = mockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const retry = runner.run();
    child.emit("close", 0);
    expect(await retry).toBe(true);
  });

  it("reports spawn errors and cleans up timeout listeners", async () => {
    const exits = process.listenerCount("exit");
    const result = new AuthRunner().run();
    const failure = expect(result).rejects.toMatchObject({ kind: "failed" });
    child.emit("error", new Error("ENOENT"));
    await failure;
    expect(process.listenerCount("exit")).toBe(exits);
    expect(vi.getTimerCount()).toBe(0);
  });
});
