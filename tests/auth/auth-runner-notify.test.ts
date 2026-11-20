import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { AuthRunner } from "../../src/auth/auth-runner.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../src/utils/dev-activity.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/utils/dev-activity.js")>(), devActivity: vi.fn(),
}));
const notifyApprovalNumber = vi.fn(async () => true);
vi.mock("../../src/utils/notify.js", () => ({ notifyApprovalNumber: (n: string | undefined) => notifyApprovalNumber(n) }));

describe("AuthRunner approval notification", () => {
  let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  beforeEach(() => {
    vi.useFakeTimers();
    child = Object.assign(new EventEmitter(), { pid: 12345, stderr: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.mocked(execFileSync).mockReturnValue("12345 100\n" as never);
    vi.spyOn(process, "kill").mockReturnValue(true);
    notifyApprovalNumber.mockClear();
  });
  afterEach(() => {
    child.emit("close", 0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("hands the pending number to the notifier, and nothing else", async () => {
    const failure = expect(new AuthRunner().run()).rejects.toMatchObject({ kind: "mfaPending", numberMatch: "91" });
    child.stdout.write("MFA_NUMBER:91\n");
    await failure;
    expect(notifyApprovalNumber).toHaveBeenCalledWith("91");
    expect(notifyApprovalNumber.mock.calls.every((call) => call.length === 1)).toBe(true);
  });
});
