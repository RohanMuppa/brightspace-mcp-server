import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFY_SCRIPT, OSASCRIPT, cleanNotificationText, notificationsEnabled, notify, notifyApprovalNumber, osascriptArgs, resetApprovalNotifications } from "../../src/utils/notify.js";

const mac = (run = vi.fn(async () => {}), env: NodeJS.ProcessEnv = {}) => ({ platform: "darwin" as const, env, run });

describe("notify", () => {
  beforeEach(() => resetApprovalNotifications());

  it("runs /usr/bin/osascript with a fixed script and the text as argv", async () => {
    const deps = mac();
    expect(await notify({ title: "Brightspace", message: "ECE 362: 3 new files" }, deps)).toBe(true);
    const [file, args, timeout] = deps.run.mock.calls[0] as unknown as [string, string[], number];
    expect(file).toBe(OSASCRIPT);
    expect(timeout).toBe(5000);
    expect(args).toEqual([...NOTIFY_SCRIPT.flatMap((l) => ["-e", l]), "--", "ECE 362: 3 new files", "Brightspace"]);
  });

  it("never puts the text in the AppleScript source", async () => {
    const deps = mac();
    const evil = 'x" & (do shell script "touch /tmp/pwned") & "\\ \n end run';
    await notify({ title: evil, message: evil }, deps);
    const args = (deps.run.mock.calls[0] as unknown as [string, string[]])[1];
    const source = args.slice(0, args.indexOf("--")).filter((_, i) => i % 2 === 1).join("\n");
    expect(source).not.toContain("pwned");
    expect(source).toBe(NOTIFY_SCRIPT.join("\n"));
    // The text is still delivered, as one argument each, flattened to one line.
    expect(args.slice(args.indexOf("--") + 1)).toEqual([expect.stringContaining('do shell script "touch /tmp/pwned"'), expect.any(String)]);
    expect(args.join("")).not.toMatch(/\n/);
  });

  it("keeps quotes, backslashes and unicode intact and guards a leading dash", async () => {
    const deps = mac();
    await notify({ title: "-t", message: '-"Intro" \\ café 日本😀' }, deps);
    const args = (deps.run.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args[args.indexOf("--") + 1]).toBe('-"Intro" \\ café 日本😀');
    expect(args.indexOf("--")).toBeLessThan(args.indexOf('-"Intro" \\ café 日本😀'));
  });

  it("strips control characters and caps the length without splitting a character", () => {
    expect(cleanNotificationText("a\u0000b\u001b[31m\nc d", 50)).toBe("a b [31m c d");
    const long = cleanNotificationText("😀".repeat(500), 200);
    expect(Array.from(long)).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
    expect(cleanNotificationText(undefined, 10)).toBe("");
  });

  it("names the folder in the text when openPath is given", async () => {
    const deps = mac();
    await notify({ title: "Brightspace", message: "ECE 362: 3 new files", openPath: "/Users/me/Courses/ECE-362" }, deps);
    expect((deps.run.mock.calls[0] as unknown as [string, string[]])[1].at(-2)).toBe("ECE 362: 3 new files (ECE-362)");
  });

  it("does nothing on other platforms", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const run = vi.fn(async () => {});
      expect(await notify({ title: "t", message: "m" }, { platform, env: {}, run })).toBe(false);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it.each(["0", "false", "No", "off"])("is off with D2L_NOTIFY=%s", async (value) => {
    const deps = mac(vi.fn(async () => {}), { D2L_NOTIFY: value });
    expect(notificationsEnabled(deps.env)).toBe(false);
    expect(await notify({ title: "t", message: "m" }, deps)).toBe(false);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("is on when D2L_NOTIFY is unset or 1", () => {
    expect(notificationsEnabled({})).toBe(true);
    expect(notificationsEnabled({ D2L_NOTIFY: "1" })).toBe(true);
  });

  it("never throws: a failing, throwing or hanging-then-timed-out runner just returns false", async () => {
    expect(await notify({ title: "t", message: "m" }, mac(vi.fn(async () => { throw new Error("boom"); })))).toBe(false);
    expect(await notify({ title: "t", message: "m" }, mac(vi.fn(() => { throw new Error("sync boom"); }) as never))).toBe(false);
    expect(await notify(undefined as never, mac())).toBe(false);
    expect(await notify({ title: "t", message: "" }, mac())).toBe(false);
  });

  it("builds the argument list used with a real exit-code runner", () => {
    expect(osascriptArgs("T", "M").slice(-3)).toEqual(["--", "M", "T"]);
  });
});

describe("notifyApprovalNumber", () => {
  beforeEach(() => resetApprovalNotifications());

  it("notifies once per distinct number", async () => {
    const deps = mac();
    expect(await notifyApprovalNumber("91", deps)).toBe(true);
    expect(await notifyApprovalNumber("91", deps)).toBe(false);
    expect(await notifyApprovalNumber("47", deps)).toBe(true);
    expect(deps.run).toHaveBeenCalledTimes(2);
    const args = (deps.run.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args.slice(-2)).toEqual(["Approve 91 in Microsoft Authenticator", "Brightspace sign-in"]);
  });

  it("ignores a missing or malformed number and honours the opt-out", async () => {
    const deps = mac();
    expect(await notifyApprovalNumber(undefined, deps)).toBe(false);
    expect(await notifyApprovalNumber("12345", deps)).toBe(false);
    expect(await notifyApprovalNumber("9; rm", deps)).toBe(false);
    expect(deps.run).not.toHaveBeenCalled();
    expect(await notifyApprovalNumber("55", mac(vi.fn(async () => {}), { D2L_NOTIFY: "0" }))).toBe(false);
  });
});
