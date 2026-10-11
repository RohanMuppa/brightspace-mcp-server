import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { AuthRunner } from "../../src/auth/auth-runner.js";
import { sanitizeError } from "../../src/tools/tool-helpers.js";

/**
 * Issue #212: a client batching N Brightspace calls in parallel against an
 * expired session got N full "authentication pending" answers, each repeating
 * the same Entra number and the same long instructions, so the user could not
 * tell which tool answered. Intended behavior (single-flight): the first
 * caller owns the sign-in and its answer alone carries the digits and the full
 * notice; concurrent callers get a short "sign-in already in progress, retry"
 * answer without the digits, and none of them blocks for the MFA window. The
 * digits must still reach someone if the owner's answer is lost (issue #201).
 */

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../src/utils/dev-activity.js", () => ({ devActivity: vi.fn() }));

const children: EventEmitter[] = [];
const NUMBER = "47";
const BATCH = 5;
/** Wording only the full notice carries (AuthFailureKind "mfaPending" guidance). */
const LONG_NOTICE = /Tell the user that number/;

function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, stderr: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(),
  });
  children.push(child);
  return child;
}

/** What an MCP client would be shown for one tool call that ended in `error`. */
function answerText(error: unknown): string {
  return sanitizeError(error).content.map((block) => (block as { text: string }).text).join("\n");
}

/** Run one call to completion and capture the answer text it would produce. */
function answer(call: Promise<boolean>): Promise<string> {
  return call.then(
    () => "SIGNED_IN",
    (error: unknown) => answerText(error),
  );
}

const withDigits = (answers: string[]) => answers.filter((text) => text.includes(NUMBER));
const withLongNotice = (answers: string[]) => answers.filter((text) => LONG_NOTICE.test(text));

describe("a parallel batch of tool calls against an expired session", () => {
  let child: ReturnType<typeof mockChild>;

  beforeEach(() => {
    vi.useFakeTimers();
    child = mockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(execFileSync).mockReturnValue("12345 100\n" as never);
    vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => {
    for (const leftover of children.splice(0)) leftover.emit("close", 0);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("puts the number-match digits in exactly one response, not one per call", async () => {
    const runner = new AuthRunner();
    const answers = BATCH_ANSWERS(runner);
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);

    const texts = await Promise.all(answers);

    expect(withDigits(texts)).toHaveLength(1);
  });

  it("puts the long MFA instructions in exactly one response, not one per call", async () => {
    const runner = new AuthRunner();
    const answers = BATCH_ANSWERS(runner);
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);

    const texts = await Promise.all(answers);

    expect(withLongNotice(texts)).toHaveLength(1);
  });

  it("gives the owner the digits and full notice, and every other call a short retry answer", async () => {
    const runner = new AuthRunner();
    const answers = BATCH_ANSWERS(runner);
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);

    const [owner, ...contenders] = await Promise.all(answers);

    expect(owner).toContain(NUMBER);
    expect(owner).toMatch(LONG_NOTICE);
    for (const text of contenders) {
      expect(text).toMatch(/sign-in (is )?already in progress/i);
      expect(text).toMatch(/retry|try again/i);
      expect(text).not.toContain(NUMBER);
      expect(text.length).toBeLessThan(owner.length / 2);
    }
  });

  it("reports an automatic code sign-in once too, without telling anyone to approve", async () => {
    // With a saved enrollment the child announces AUTH_AUTOMATIC_PENDING instead
    // of a number. Every caller joins and waits (nobody is asked to relay
    // anything); if the sign-in is still typing its code when the poll window
    // lapses, all of them are answered at once, which is #212 again.
    const runner = new AuthRunner();
    const answers = BATCH_ANSWERS(runner);
    child.stdout.write("AUTH_AUTOMATIC_PENDING\n");
    await vi.advanceTimersByTimeAsync(46_000);

    const [owner, ...contenders] = await Promise.all(answers);

    expect(owner).toMatch(/answering its own verification code/);
    for (const text of contenders) {
      expect(text).toMatch(/sign-in is already in progress/i);
      expect(text).toMatch(/retry/i);
      expect(text).not.toMatch(/approve the sign-in|enter \d+/i);
      expect(text.length).toBeLessThan(owner.length);
    }
  });

  it("starts one sign-in for the whole batch", async () => {
    const runner = new AuthRunner();
    BATCH_ANSWERS(runner);
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);
    await vi.advanceTimersByTimeAsync(0);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("answers a concurrent caller within seconds, not after the MFA window", async () => {
    const runner = new AuthRunner();
    const owner = answer(runner.run());
    const startedAt = Date.now();
    let contenderText: string | undefined;
    let contenderAnsweredAt = 0;
    void answer(runner.run()).then((text) => { contenderText = text; contenderAnsweredAt = Date.now(); });
    await vi.advanceTimersByTimeAsync(1000);
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);
    await owner;
    await vi.advanceTimersByTimeAsync(5000);

    expect(contenderText).toBeDefined();
    expect(contenderAnsweredAt - startedAt).toBeLessThanOrEqual(6000);
    expect(contenderText).toMatch(/already in progress/i);
    expect(contenderText).not.toContain(NUMBER);
  });

  it("still delivers the digits to the next caller when the owner's response was lost", async () => {
    const runner = new AuthRunner();
    // The owner's answer is produced but never relayed to the user.
    const lost = answer(runner.run());
    child.stdout.write(`MFA_NUMBER:${NUMBER}\n`);
    await lost;

    // A later call (another batch, or the model retrying) must carry the digits.
    const later = answer(runner.run());
    await vi.advanceTimersByTimeAsync(46_000);
    const text = await later;

    expect(text).toContain(NUMBER);
    expect(text).toMatch(LONG_NOTICE);
  });

  function BATCH_ANSWERS(runner: AuthRunner): Promise<string>[] {
    return Array.from({ length: BATCH }, () => answer(runner.run()));
  }
});
