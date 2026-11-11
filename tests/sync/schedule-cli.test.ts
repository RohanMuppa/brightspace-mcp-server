import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { LABEL_PREFIX, buildPlist, chooseNodePath, scheduleEnvironment, parsePlist, parseScheduleArgs, runSchedule, xmlEscape, SCHEDULE_USAGE, type ScheduleDeps } from "../../src/sync/schedule-cli.js";

const AGENTS = "/home/u/Library/LaunchAgents";

function setup(overrides: Partial<ScheduleDeps> = {}, existing: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(existing));
  const modes = new Map<string, number>();
  // `print` says the label is gone (113) unless a test overrides it.
  const launchctl = vi.fn(async (args: string[]) => ({ code: args[0] === "print" ? 113 : 0, stderr: "" }));
  const fs = {
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
    readdir: vi.fn(async () => [...files.keys()].map((f) => path.basename(f))),
    readFile: vi.fn(async (f: string) => { const v = files.get(f); if (v === undefined) throw new Error("ENOENT"); return v; }),
    writeFileAtomic: vi.fn(async (f: string, data: string, o: { mode: number }) => { files.set(f, data); modes.set(f, o.mode); }),
    rm: vi.fn(async (f: string) => { files.delete(f); }),
    exists: vi.fn(async (f: string) => files.has(f)),
  };
  const deps: ScheduleDeps = {
    platform: "darwin", uid: 501, agentsDir: AGENTS, logDir: "/home/u/.d2l-session/logs",
    nodePath: "/opt/homebrew/bin/node", scriptPath: "/opt/homebrew/lib/node_modules/brightspace-mcp-server/dist/index.js",
    launchctl, fs, checkDestination: vi.fn(async () => null), sleep: vi.fn(async () => {}), ...overrides,
  };
  let out = ""; let err = "";
  const io = { stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; } };
  return { deps, io, files, modes, launchctl, fs, out: () => out, err: () => err };
}
const plistPath = (id: number) => `${AGENTS}/${LABEL_PREFIX}${id}.plist`;
const ours = (id: number, dest = "/home/u/C") => buildPlist({ courseId: id, destination: dest, existing: "skip", hour: 9, minute: 0, nodePath: "/n", scriptPath: "/s", logFile: "/l" });
const add = ["--course", "123456", "--dest", "/home/u/Courses/ECE", "--at", "08:05"];

describe("parseScheduleArgs", () => {
  it("reads an add", () => {
    expect(parseScheduleArgs(add)).toEqual({ action: "add", courseId: 123456, destination: "/home/u/Courses/ECE", hour: 8, minute: 5, existing: "skip" });
  });
  it.each([
    [["--course", "0", "--dest", "/x", "--at", "08:00"], /--course/],
    [["--course", "-5", "--dest", "/x", "--at", "08:00"], /--course/],
    [["--course", "1e3", "--dest", "/x", "--at", "08:00"], /--course/],
    [["--course", "5", "--at", "08:00"], /--dest/],
    [["--course", "5", "--dest", "/x"], /--at/],
    [["--course", "5", "--dest", "/x", "--at", "24:00"], /--at/],
    [["--course", "5", "--dest", "/x", "--at", "8:60"], /--at/],
    [["--course", "5", "--dest", "/x", "--at", "noon"], /--at/],
    [["--course", "5", "--dest", "/x\n<evil>", "--at", "08:00"], /control/],
    [["--course", "5", "--dest", "/x", "--at", "08:00", "--existing", "nope"], /--existing/],
    [["--list", "--remove"], /not both/],
    [["--remove"], /--course/],
    [["--bogus"], /Unknown/],
  ])("rejects %j", (argv, message) => {
    expect(parseScheduleArgs(argv)).toMatchObject({ error: expect.stringMatching(message) });
  });
  it("reads list, remove and help", () => {
    expect(parseScheduleArgs(["--list"])).toEqual({ action: "list" });
    expect(parseScheduleArgs(["--remove", "--course", "7"])).toEqual({ action: "remove", courseId: 7 });
    expect(parseScheduleArgs(["--help"])).toEqual({ help: true });
  });
});

describe("plist", () => {
  it("escapes every value", () => {
    expect(xmlEscape(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
  });

  it("holds absolute node and script, the sync arguments, the interval and logs, with hostile paths escaped", () => {
    const plist = buildPlist({ courseId: 42, destination: `/home/u/A&B <x> "q" 'z'`, existing: "keep_both", hour: 8, minute: 5, nodePath: "/opt/node", scriptPath: "/opt/pkg/dist/index.js", logFile: "/l/sync-42.log" });
    expect(plist).toContain("<string>com.brightspace-mcp-server.sync.42</string>");
    expect(plist).toContain("<string>/opt/node</string>\n    <string>/opt/pkg/dist/index.js</string>\n    <string>sync</string>");
    expect(plist).toContain("<string>--notify</string>");
    expect(plist).toContain("<key>Hour</key>\n    <integer>8</integer>\n    <key>Minute</key>\n    <integer>5</integer>");
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("A&amp;B &lt;x&gt; &quot;q&quot; &apos;z&apos;");
    expect(plist).not.toContain("<x>");
    expect(plist).toContain("<key>StandardOutPath</key>\n  <string>/l/sync-42.log</string>");
    expect(plist).toContain("<key>StandardErrorPath</key>\n  <string>/l/sync-42.log</string>");
    expect(plist).not.toContain("npx");
    expect(parsePlist(plist, 42)).toEqual({ courseId: 42, time: "08:05", destination: `/home/u/A&B <x> "q" 'z'` });
  });
});

describe("runSchedule add", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it("validates the destination, writes the plist 0644, then bootstraps it", async () => {
    expect(await runSchedule(add, t.io, t.deps)).toBe(0);
    expect(t.deps.checkDestination).toHaveBeenCalledWith("/home/u/Courses/ECE");
    expect(t.modes.get(plistPath(123456))).toBe(0o644);
    expect(t.files.get(plistPath(123456))).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(t.launchctl.mock.calls).toEqual([[["bootstrap", "gui/501", plistPath(123456)]]]);
    expect(t.out()).toContain("daily at 08:05");
    expect(t.fs.mkdir).toHaveBeenCalledWith("/home/u/.d2l-session/logs", { recursive: true, mode: 0o700 });
  });

  it("tightens a log directory that already exists to 0700 (L6)", async () => {
    expect(await runSchedule(add, t.io, t.deps)).toBe(0);
    expect(t.fs.chmod).toHaveBeenCalledWith("/home/u/.d2l-session/logs", 0o700);
  });

  it("bakes the non-secret D2L_* settings into EnvironmentVariables and never a secret (M2)", async () => {
    t = setup({ env: {
      D2L_BASE_URL: "https://x.edu", D2L_SESSION_DIR: "/home/u/s", D2L_NOTIFY: "0", D2L_INCLUDE_COURSES: "1,2",
      D2L_ACCESS_TOKEN: "tok-secret", D2L_SESSION_COOKIE: "cookie-secret", D2L_PASSWORD: "pw-secret",
      D2L_TOTP_SECRET: "totp-secret", D2L_HTTP_TOKEN: "http-secret", D2L_FUTURE_THING: "unknown-secret", HOME: "/home/u",
    } });
    expect(await runSchedule(add, t.io, t.deps)).toBe(0);
    const plist = t.files.get(plistPath(123456))!;
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>D2L_BASE_URL</key>\n    <string>https://x.edu</string>");
    expect(plist).toContain("<key>D2L_NOTIFY</key>\n    <string>0</string>");
    expect(plist).toContain("<key>D2L_SESSION_DIR</key>");
    expect(plist).toContain("<key>D2L_INCLUDE_COURSES</key>");
    for (const secret of ["secret", "D2L_ACCESS_TOKEN", "D2L_PASSWORD", "D2L_HTTP_TOKEN", "D2L_FUTURE_THING", "HOME"]) expect(plist).not.toContain(secret);
  });

  it("computes the log path from the same environment it bakes", async () => {
    t = setup({ env: { D2L_SESSION_DIR: "/home/u/s" }, logDir: "/home/u/s/logs" });
    await runSchedule(add, t.io, t.deps);
    expect(t.files.get(plistPath(123456))).toContain("<string>/home/u/s/logs/sync-123456.log</string>");
  });

  it("waits for the old label to disappear before bootstrapping a replacement (L2)", async () => {
    t = setup({}, { [plistPath(123456)]: ours(123456) });
    let prints = 0;
    t.launchctl.mockImplementation(async (a: string[]) => ({ code: a[0] === "print" ? (++prints < 3 ? 0 : 113) : 0, stderr: "" }));
    expect(await runSchedule(add, t.io, t.deps)).toBe(0);
    expect(t.launchctl.mock.calls.map((c) => c[0][0])).toEqual(["bootout", "print", "print", "print", "bootstrap"]);
  });

  it("retries bootstrap once after a pause when replacing a schedule (L2)", async () => {
    t = setup({}, { [plistPath(123456)]: ours(123456) });
    let bootstraps = 0;
    t.launchctl.mockImplementation(async (a: string[]) => ({ code: a[0] === "print" ? 113 : a[0] === "bootstrap" && ++bootstraps === 1 ? 5 : 0, stderr: "Input/output error" }));
    expect(await runSchedule(add, t.io, t.deps)).toBe(0);
    expect(bootstraps).toBe(2);
    expect(t.deps.sleep).toHaveBeenCalledWith(500);
    expect(t.launchctl.mock.calls.some((c) => c[0][0] === "load")).toBe(false);
  });

  it("warns when node is a versioned path with no stable twin (L1), and uses a stable twin when it is the same binary", async () => {
    t = setup({ nodePath: "/opt/homebrew/Cellar/node/22.1.0/bin/node", realpath: vi.fn(async (p: string) => p) });
    await runSchedule(add, t.io, t.deps);
    expect(t.err()).toMatch(/node.*(upgrade|disappear|versioned)/i);
    const real = "/opt/homebrew/Cellar/node/22.1.0/bin/node";
    expect(await chooseNodePath(real, async (p) => (p === "/opt/homebrew/bin/node" || p === real ? real : p), ["/opt/homebrew/bin/node", "/usr/local/bin/node"])).toEqual({ path: "/opt/homebrew/bin/node" });
    expect(await chooseNodePath(real, async (p) => (p === "/usr/local/bin/node" ? "/other/node" : p === real ? real : p), ["/opt/homebrew/bin/node", "/usr/local/bin/node"])).toMatchObject({ path: real, warning: expect.any(String) });
    expect(await chooseNodePath("/usr/local/bin/node", async (p) => p, ["/opt/homebrew/bin/node", "/usr/local/bin/node"])).toEqual({ path: "/usr/local/bin/node" });
    expect(await chooseNodePath("/home/u/.nvm/versions/node/v22/bin/node", async () => { throw new Error("ENOENT"); }, ["/usr/local/bin/node"])).toMatchObject({ warning: expect.any(String) });
  });

  it("scheduleEnvironment keeps only allowlisted, single-line values", () => {
    expect(scheduleEnvironment({ D2L_BASE_URL: "https://a", D2L_PASSWORD: "x", D2L_USERNAME: "a\nb", D2L_NOTIFY: "" }, "/opt/homebrew/bin/node")).toEqual({
      D2L_BASE_URL: "https://a", PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    });
  });

  it("falls back to launchctl load when bootstrap fails", async () => {
    t.launchctl.mockResolvedValueOnce({ code: 5, stderr: "nope" });
    expect(await runSchedule(add, t.io, t.deps)).toBe(0);
    expect(t.launchctl.mock.calls[1][0]).toEqual(["load", plistPath(123456)]);
  });

  it("fails with a message when neither loads", async () => {
    t.launchctl.mockResolvedValue({ code: 5, stderr: "denied" });
    expect(await runSchedule(add, t.io, t.deps)).toBe(1);
    expect(t.err()).toContain("denied");
  });

  it("boots out an existing schedule for that course first", async () => {
    t = setup({}, { [plistPath(123456)]: ours(123456, "old") });
    expect(await runSchedule(add, t.io, t.deps)).toBe(0);
    expect(t.launchctl.mock.calls.map((c) => c[0][0])).toEqual(["bootout", "print", "bootstrap"]);
    expect(t.launchctl.mock.calls[0][0]).toEqual(["bootout", `gui/501/${LABEL_PREFIX}123456`]);
    expect(t.files.get(plistPath(123456))).not.toContain("old");
  });

  it("refuses a protected destination before writing or running anything", async () => {
    t = setup({ checkDestination: vi.fn(async () => "a hidden folder") });
    expect(await runSchedule(add, t.io, t.deps)).toBe(2);
    expect(t.fs.writeFileAtomic).not.toHaveBeenCalled();
    expect(t.fs.mkdir).not.toHaveBeenCalled();
    expect(t.launchctl).not.toHaveBeenCalled();
  });

  it.each([["0"], ["-3"], ["abc"], ["12.5"]])("refuses course id %s with exit 2 and writes nothing", async (id) => {
    expect(await runSchedule(["--course", id, "--dest", "/x", "--at", "08:00"], t.io, t.deps)).toBe(2);
    expect(t.fs.writeFileAtomic).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("says not supported on %s and exits 2", async (platform) => {
    t = setup({ platform });
    expect(await runSchedule(add, t.io, t.deps)).toBe(2);
    expect(t.err()).toMatch(/not supported yet/);
    expect(t.launchctl).not.toHaveBeenCalled();
    expect(t.fs.writeFileAtomic).not.toHaveBeenCalled();
    expect(await runSchedule(["--list"], t.io, t.deps)).toBe(2);
  });

  it("prints help and warns about an npx-cache script", async () => {
    expect(await runSchedule(["--help"], t.io, t.deps)).toBe(0);
    expect(t.out()).toBe(SCHEDULE_USAGE);
    t = setup({ scriptPath: "/home/u/.npm/_npx/abc/node_modules/brightspace-mcp-server/dist/index.js" });
    await runSchedule(add, t.io, t.deps);
    expect(t.err()).toMatch(/npx cache/);
  });
});

describe("runSchedule list and remove", () => {
  it("lists only our plists", async () => {
    const mine = buildPlist({ courseId: 7, destination: "/home/u/C", existing: "skip", hour: 9, minute: 0, nodePath: "/n", scriptPath: "/s", logFile: "/l" });
    const t = setup({}, {
      [plistPath(7)]: mine,
      [`${AGENTS}/com.apple.something.plist`]: "x",
      [`${AGENTS}/${LABEL_PREFIX}abc.plist`]: "x",
      [`${AGENTS}/${LABEL_PREFIX}0.plist`]: "x",
      [`${AGENTS}/${LABEL_PREFIX}7.plist.bak`]: "x",
    });
    expect(await runSchedule(["--list"], t.io, t.deps)).toBe(0);
    expect(t.out()).toBe("course 7  daily at 09:00  /home/u/C\n");
  });

  it("says so when there are none", async () => {
    const t = setup();
    await runSchedule(["--list"], t.io, t.deps);
    expect(t.out()).toBe("No scheduled syncs.\n");
  });

  it("removes only its own plist after booting it out", async () => {
    const t = setup({}, { [plistPath(7)]: ours(7), [`${AGENTS}/com.apple.something.plist`]: "x" });
    expect(await runSchedule(["--remove", "--course", "7"], t.io, t.deps)).toBe(0);
    expect(t.launchctl.mock.calls[0][0]).toEqual(["bootout", `gui/501/${LABEL_PREFIX}7`]);
    expect(t.fs.rm).toHaveBeenCalledTimes(1);
    expect(t.fs.rm).toHaveBeenCalledWith(plistPath(7));
    expect(t.files.has(`${AGENTS}/com.apple.something.plist`)).toBe(true);
  });

  it("skips a plist whose Label is not ours: list warns and omits it, remove leaves it alone (L7)", async () => {
    const foreign = ours(7).replace(`${LABEL_PREFIX}7`, "com.evil.other");
    const t = setup({}, { [plistPath(7)]: foreign, [plistPath(8)]: ours(8) });
    expect(await runSchedule(["--list"], t.io, t.deps)).toBe(0);
    expect(t.out()).toBe("course 8  daily at 09:00  /home/u/C\n");
    expect(t.err()).toMatch(/course 7|Label/);
    const r = setup({}, { [plistPath(7)]: foreign });
    r.launchctl.mockResolvedValue({ code: 3, stderr: "" });
    expect(await runSchedule(["--remove", "--course", "7"], r.io, r.deps)).toBe(1);
    expect(r.err()).toMatch(/Label/);
    expect(r.fs.rm).not.toHaveBeenCalled();
    expect(r.launchctl.mock.calls.some((c) => c[0][0] === "unload")).toBe(false);
  });

  it("falls back to unload, and reports a course with no schedule", async () => {
    const t = setup({}, { [plistPath(7)]: ours(7) });
    t.launchctl.mockResolvedValueOnce({ code: 3, stderr: "" });
    await runSchedule(["--remove", "--course", "7"], t.io, t.deps);
    expect(t.launchctl.mock.calls[1][0]).toEqual(["unload", plistPath(7)]);
    expect(await runSchedule(["--remove", "--course", "8"], t.io, t.deps)).toBe(1);
    expect(t.err()).toMatch(/No schedule for course 8/);
  });

  it("refuses a path-like course id on remove", async () => {
    const t = setup();
    expect(await runSchedule(["--remove", "--course", "../../x"], t.io, t.deps)).toBe(2);
    expect(t.fs.rm).not.toHaveBeenCalled();
  });
});
