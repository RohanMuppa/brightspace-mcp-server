import type { ChildProcessWithoutNullStreams } from "node:child_process";

export const STARTUP_TIMEOUT_MS = 4_000;
export const EXIT_TIMEOUT_MS = 2_000;

/** Attach immediately after spawn: readiness is a complete line, not one arbitrary chunk. */
export function watchProcess(child: ChildProcessWithoutNullStreams, startupTimeoutMs = STARTUP_TIMEOUT_MS) {
  let output = "";
  let stderr = "";
  let finished = false;
  let rejectReady: (error: Error) => void;
  let rejectExit: (error: Error) => void;
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  const ready = new Promise<string>((resolve, reject) => {
    rejectReady = reject;
    const onData = (chunk: Buffer | string) => {
      output += String(chunk);
      const newline = output.indexOf("\n");
      if (newline >= 0) {
        child.stdout.off("data", onData);
        clearTimeout(timer);
        resolve(output.slice(0, newline).trim());
      }
    };
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error(`Child did not report readiness within ${startupTimeoutMs}ms; stderr: ${stderr}`));
    }, startupTimeoutMs);
    child.stdout.on("data", onData);
    child.once("close", () => { clearTimeout(timer); child.stdout.off("data", onData); });
    child.once("error", () => { clearTimeout(timer); child.stdout.off("data", onData); });
  });
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2_000); });
  child.once("error", error => {
    finished = true;
    rejectReady(error);
    rejectExit(error);
  });
  child.once("close", (code, signal) => {
    finished = true;
    rejectReady(new Error(`Child closed before readiness (code ${code}, signal ${signal}); stderr: ${stderr}`));
    resolveExit();
  });
  // Callers may await readiness before exit; an early spawn error must not
  // become an unhandled rejection on the other promise in the meantime.
  void ready.catch(() => {});
  void exited.catch(() => {});
  return { child, ready, exited, get finished() { return finished; } };
}

export type ProcessFixture = ReturnType<typeof watchProcess>;

export async function waitForExit(fixture: ProcessFixture, timeoutMs = EXIT_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      fixture.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Child did not exit within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function stopProcess(fixture: ProcessFixture): Promise<void> {
  if (!fixture.finished) fixture.child.kill("SIGKILL");
  await waitForExit(fixture);
}
