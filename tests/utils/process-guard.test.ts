import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { guardServerProcess, type GuardedProcess } from "../../src/utils/process-guard.js";

/** A stand-in for `process`: the stdio server's only boundary with its client. */
function fakeProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new EventEmitter(),
    stdout: new EventEmitter(),
    exit: vi.fn(),
  });
  return proc as typeof proc & GuardedProcess;
}

function pipeError(): NodeJS.ErrnoException {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

describe("guardServerProcess", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  const logged = () => stderr.mock.calls.map((call) => call.join(" ")).join("\n");

  beforeEach(() => {
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps serving after an uncaught exception instead of closing the client's transport", () => {
    const proc = fakeProcess();
    guardServerProcess(proc);

    proc.emit("uncaughtException", new Error("stray listener threw"));

    expect(proc.exit).not.toHaveBeenCalled();
    expect(logged()).toMatch(/stray listener threw/);
    expect(logged()).toMatch(/still running/i);
  });

  it("logs an unhandled rejection without exiting", () => {
    const proc = fakeProcess();
    guardServerProcess(proc);

    proc.emit("unhandledRejection", new Error("late rejection"));

    expect(proc.exit).not.toHaveBeenCalled();
    expect(logged()).toMatch(/late rejection/);
  });

  it("exits cleanly with an explanation when the client's end of stdout is gone", () => {
    const proc = fakeProcess();
    guardServerProcess(proc);

    proc.stdout.emit("error", pipeError());

    expect(proc.exit).toHaveBeenCalledWith(0);
    expect(logged()).toMatch(/client closed the connection/i);
  });

  it("keeps serving through a stdout error that is not a closed pipe", () => {
    const proc = fakeProcess();
    guardServerProcess(proc);

    proc.stdout.emit("error", Object.assign(new Error("write EAGAIN"), { code: "EAGAIN" }));

    expect(proc.exit).not.toHaveBeenCalled();
    expect(logged()).toMatch(/EAGAIN/);
  });

  it("says why the server stopped when the client closes stdin", () => {
    const proc = fakeProcess();
    guardServerProcess(proc);

    proc.stdin.emit("end");

    expect(logged()).toMatch(/client closed stdin/i);
  });

  it("tells the user how to reconnect when the server exits with an error", () => {
    const proc = fakeProcess();
    guardServerProcess(proc);

    proc.emit("exit", 1);

    expect(logged()).toMatch(/exited with code 1/);
    expect(logged()).toMatch(/restart|reconnect/i);
  });

  it("stays quiet about reconnecting on a clean exit", () => {
    const proc = fakeProcess();
    guardServerProcess(proc);

    proc.emit("exit", 0);

    expect(logged()).not.toMatch(/reconnect/i);
  });
});
