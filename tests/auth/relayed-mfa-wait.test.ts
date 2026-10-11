import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout as realSleep } from "node:timers/promises";
import { spawn, execFileSync } from "node:child_process";
import { AuthRunner } from "../../src/auth/auth-runner.js";
import { sanitizeError } from "../../src/tools/tool-helpers.js";

/**
 * Two server processes share one session store (Claude Desktop and a terminal
 * session, say). Process A's background sign-in holds the cross-process lock
 * and waits on an Authenticator approval. Process B's child finds the lock,
 * relays A's challenge and exits "busy". That used to answer every retry in B
 * at once with the same number, so a model retrying in a loop made seven calls
 * in thirty seconds and concluded the approval window had closed while A's
 * sign-in was still waiting. A retry in B now waits on A, the way a retry
 * joining a local background child polls it.
 */

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../src/utils/dev-activity.js", () => ({ devActivity: vi.fn() }));

const children: EventEmitter[] = [];

function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, stderr: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(),
  });
  children.push(child);
  return child;
}

type Child = ReturnType<typeof mockChild>;

/**
 * Advance the fake clock, a second at a time, letting the real file-system
 * calls the relay poll makes finish between steps. Fake timers do not drive
 * real I/O, and the poll awaits it before arming its next timer.
 */
async function pass(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1000) {
    await vi.advanceTimersByTimeAsync(Math.min(1000, left));
    await realSleep(25);
  }
  await realSleep(25);
}

/** What this process's child prints when it finds another process's sign-in holding the lock. */
async function relay(child: Child, marker: string): Promise<void> {
  child.stdout.write(`AUTH_RELAYED\n${marker}\n`);
  await pass(1);
  child.emit("close", 2);
  await pass(1);
}

function nextChild(): Child {
  const child = mockChild();
  vi.mocked(spawn).mockReturnValue(child as never);
  return child;
}

function answerText(error: unknown): string {
  return sanitizeError(error).content.map((block) => (block as { text: string }).text).join("\n");
}

/** Track whether and how a call has settled, without awaiting it. */
function track<T>(call: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined, error: undefined as unknown };
  call.then((value) => { state.settled = true; state.value = value; }, (error: unknown) => { state.settled = true; state.error = error; });
  return state;
}

describe("a caller whose sign-in found another process holding the lock", () => {
  let sessionDir: string;
  let lockDir: string;
  let challengeFile: string;
  let child: Child;

  const publish = (challenge: object) => fs.writeFileSync(challengeFile, JSON.stringify(challenge));

  beforeEach(() => {
    vi.useFakeTimers();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "brightspace-relayed-wait-test-"));
    lockDir = path.join(sessionDir, ".auth.lock");
    challengeFile = path.join(lockDir, "challenge.json");
    fs.mkdirSync(lockDir);
    publish({ numberMatch: "72" });
    child = nextChild();
    vi.mocked(execFileSync).mockReturnValue("12345 100\n" as never);
    vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => {
    for (const leftover of children.splice(0)) leftover.emit("close", 0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  /** The first call: it tells the user the number, which is all it has to do. */
  async function firstCallTold(runner: AuthRunner, marker = "MFA_NUMBER:72") {
    const first = track(runner.run());
    await relay(child, marker);
    await pass(10);
    expect(first.settled).toBe(true);
    child = nextChild();
    return first;
  }

  it("answers the first call at once with the owner's number, as before", async () => {
    const runner = new AuthRunner({ sessionDir });

    const first = await firstCallTold(runner);

    expect(first.error).toMatchObject({ kind: "mfaPending", numberMatch: "72" });
  });

  it("does not answer a retry of that challenge while the owner still holds the lock", async () => {
    const runner = new AuthRunner({ sessionDir });
    await firstCallTold(runner);

    const retry = track(runner.run());
    await relay(child, "MFA_NUMBER:72");
    await pass(30_000);

    expect(retry.settled).toBe(false);
  });

  it("answers the retry with the owner's latest number once the 45-second window ends", async () => {
    const runner = new AuthRunner({ sessionDir });
    await firstCallTold(runner);

    const retry = track(runner.run());
    await relay(child, "MFA_NUMBER:72");
    await pass(20_000);
    publish({ numberMatch: "15" });
    await pass(24_000);
    expect(retry.settled).toBe(false);
    await pass(2_000);

    expect(retry.settled).toBe(true);
    expect(retry.error).toMatchObject({ kind: "mfaPending", numberMatch: "15" });
    expect(answerText(retry.error)).toContain("15");
  });

  it("resolves the retry as soon as the owner releases the lock", async () => {
    const runner = new AuthRunner({ sessionDir });
    await firstCallTold(runner);

    const retry = track(runner.run());
    await relay(child, "MFA_NUMBER:72");
    await pass(8_000);
    expect(retry.settled).toBe(false);
    fs.rmSync(lockDir, { recursive: true });
    await pass(2_000);

    expect(retry.settled).toBe(true);
    expect(retry.value).toBe(true);
  });

  it("keeps the owner's challenge fresh while the retry waits, so the owner is not abandoned", async () => {
    const runner = new AuthRunner({ sessionDir });
    await firstCallTold(runner);
    const retry = track(runner.run());
    await relay(child, "MFA_NUMBER:72");
    const longAgo = new Date(Date.now() - 600_000);
    fs.utimesSync(challengeFile, longAgo, longAgo);

    await pass(5_000);

    expect(Date.now() - fs.statSync(challengeFile).mtimeMs).toBeLessThan(2_500);
    expect(retry.settled).toBe(false);
  });

  it("keeps it fresh until the window ends, not just once", async () => {
    const runner = new AuthRunner({ sessionDir });
    await firstCallTold(runner);
    runner.run().catch(() => {});
    await relay(child, "MFA_NUMBER:72");
    const longAgo = new Date(Date.now() - 600_000);
    fs.utimesSync(challengeFile, longAgo, longAgo);

    await pass(40_000);

    expect(Date.now() - fs.statSync(challengeFile).mtimeMs).toBeLessThan(2_500);
  });

  it("never waits past 55 seconds into the call, however late the relay arrives", async () => {
    const runner = new AuthRunner({ sessionDir });
    await firstCallTold(runner);

    const startedAt = Date.now();
    const retry = track(runner.run());
    await pass(30_000);
    await relay(child, "MFA_NUMBER:72");
    await pass(24_000);
    expect(retry.settled).toBe(false);
    await pass(1_500);

    expect(retry.settled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(56_500);
    expect(retry.error).toMatchObject({ kind: "mfaPending", numberMatch: "72" });
  });

  it("answers a retry at once when the owner is showing a different number than the one it was told", async () => {
    const runner = new AuthRunner({ sessionDir });
    await firstCallTold(runner);
    publish({ numberMatch: "33" });

    const retry = track(runner.run());
    await relay(child, "MFA_NUMBER:33");
    await pass(10);

    expect(retry.settled).toBe(true);
    expect(retry.error).toMatchObject({ kind: "mfaPending", numberMatch: "33" });
  });

  it("announces the number to a caller that can be told mid-call, then waits for the owner", async () => {
    const runner = new AuthRunner({ sessionDir });
    const onChallenge = vi.fn();

    const call = track(runner.run(onChallenge));
    await relay(child, "MFA_NUMBER:72");
    await pass(10_000);

    expect(onChallenge).toHaveBeenCalledWith("72");
    expect(call.settled).toBe(false);
    fs.rmSync(lockDir, { recursive: true });
    await pass(2_000);
    expect(call.value).toBe(true);
  });

  it("waits on an owner that is answering its own verification code, even on the first call", async () => {
    publish({ kind: "automatic" });
    const runner = new AuthRunner({ sessionDir });

    const call = track(runner.run());
    await relay(child, "AUTH_AUTOMATIC_PENDING");
    await pass(40_000);
    expect(call.settled).toBe(false);
    await pass(6_000);

    expect(call.error).toMatchObject({ kind: "automaticPending" });
  });

  it("still reports the number once to a parallel batch, and none of the batch waits", async () => {
    const runner = new AuthRunner({ sessionDir });

    const calls = Array.from({ length: 5 }, () => track(runner.run()));
    await relay(child, "MFA_NUMBER:72");
    await pass(10);

    expect(calls.every((call) => call.settled)).toBe(true);
    const texts = calls.map((call) => answerText(call.error));
    expect(texts.filter((text) => text.includes("72"))).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("leaves a runner without a session directory as it was: every retry is answered at once", async () => {
    const runner = new AuthRunner();
    const first = track(runner.run());
    await relay(child, "MFA_NUMBER:72");
    await pass(10);
    expect(first.settled).toBe(true);
    child = nextChild();

    const retry = track(runner.run());
    await relay(child, "MFA_NUMBER:72");
    await pass(10);

    expect(retry.settled).toBe(true);
    expect(retry.error).toMatchObject({ kind: "mfaPending", numberMatch: "72" });
  });

  it("does not make a child's own challenge, with no relay marker, wait on a lock", async () => {
    const runner = new AuthRunner({ sessionDir });
    await firstCallTold(runner);

    const retry = track(runner.run());
    child.stdout.write("MFA_NUMBER:72\n");
    await pass(10);

    expect(retry.settled).toBe(true);
  });
});
