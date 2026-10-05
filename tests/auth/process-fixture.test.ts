import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchProcess, waitForExit, stopProcess } from "./process-fixture.js";

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
  });
}

afterEach(() => vi.useRealTimers());

describe("authentication process fixture", () => {
  it("waits for a complete readiness line split across stdout chunks", async () => {
    const child = fakeChild();
    const fixture = watchProcess(child as unknown as ChildProcessWithoutNullStreams);
    let resolved = false;
    void fixture.ready.then(() => { resolved = true; });
    child.stdout.write("lock");
    await Promise.resolve();
    expect(resolved).toBe(false);
    child.stdout.write("ed\nmore output\n");
    expect(await fixture.ready).toBe("locked");
    child.emit("close", 0, null);
    await fixture.exited;
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  it("rejects an early exit with its code and stderr instead of hanging", async () => {
    const child = fakeChild();
    const fixture = watchProcess(child as unknown as ChildProcessWithoutNullStreams);
    child.stderr.write("invalid module");
    child.stdout.write("partial");
    child.emit("close", 2, null);
    await expect(fixture.ready).rejects.toThrow("code 2, signal null");
    await expect(fixture.ready).rejects.toThrow("invalid module");
    await fixture.exited;
  });

  it("surfaces spawn errors on readiness and exit without an unhandled rejection", async () => {
    const child = fakeChild();
    const fixture = watchProcess(child as unknown as ChildProcessWithoutNullStreams);
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    child.emit("error", error);
    await expect(fixture.ready).rejects.toBe(error);
    await expect(fixture.exited).rejects.toBe(error);
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  it("bounds startup and cleans the readiness listener", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const fixture = watchProcess(child as unknown as ChildProcessWithoutNullStreams, 20);
    await vi.advanceTimersByTimeAsync(20);
    await expect(fixture.ready).rejects.toThrow("within 20ms");
    expect(child.stdout.listenerCount("data")).toBe(0);
    child.emit("close", null, "SIGKILL");
  });

  it("bounds exit waiting independently of successful readiness", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const fixture = watchProcess(child as unknown as ChildProcessWithoutNullStreams);
    child.stdout.write("locked\n");
    const exit = waitForExit(fixture, 20);
    const assertion = expect(exit).rejects.toThrow("within 20ms");
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    child.emit("close", 0, null);
  });

  it("kills a stranded child and waits for close before cleanup completes", async () => {
    const child = fakeChild();
    const fixture = watchProcess(child as unknown as ChildProcessWithoutNullStreams);
    child.stdout.write("locked\n");
    let completed = false;
    const cleanup = stopProcess(fixture).then(() => { completed = true; });
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(completed).toBe(false);
    child.emit("close", null, "SIGKILL");
    await cleanup;
    expect(completed).toBe(true);
    await stopProcess(fixture);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
