import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { SYNC_USAGE, parseSyncArgs, runSync } from "../../src/sync/sync-cli.js";
import { fakeBrightspace, fileTopic, module_, pdf, tempRoot, type Fake } from "./harness.js";

describe("parseSyncArgs", () => {
  const ok = (argv: string[]) => {
    const parsed = parseSyncArgs(argv);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed;
  };

  it("reads every flag", () => {
    const parsed = ok(["--course", "42", "--dest", "/tmp/x", "--existing", "keep_both", "--module", "7", "--dry-run", "--json", "--max-files", "10"]);
    expect(parsed).toMatchObject({ courseId: 42, destination: path.resolve("/tmp/x"), existing: "keep_both", moduleId: 7, dryRun: true, json: true, maxFiles: 10 });
  });

  it("applies defaults and accepts --flag=value", () => {
    const parsed = ok(["--course=42", "--dest=/tmp/x"]);
    expect(parsed).toMatchObject({ courseId: 42, existing: "skip", dryRun: false, json: false });
    expect(parsed.moduleId).toBeUndefined();
    expect(parsed.maxFiles).toBeUndefined();
  });

  it("resolves a relative destination against the working directory", () => {
    expect(ok(["--course", "1", "--dest", "course"]).destination).toBe(path.resolve("course"));
  });

  it.each([
    [[], /--course/],
    [["--course", "42"], /--dest/],
    [["--dest", "/tmp/x"], /--course/],
    [["--course", "abc", "--dest", "/tmp/x"], /--course/],
    [["--course", "0", "--dest", "/tmp/x"], /--course/],
    [["--course", "1.5", "--dest", "/tmp/x"], /--course/],
    [["--course", "1", "--dest", "/tmp/x", "--existing", "overwrite"], /--existing/],
    [["--course", "1", "--dest", "/tmp/x", "--max-files", "0"], /--max-files/],
    [["--course", "1", "--dest", "/tmp/x", "--max-files", "-3"], /--max-files/],
    [["--course", "1", "--dest", "/tmp/x", "--module", "x"], /--module/],
    [["--course", "1", "--dest", "/tmp/x", "--bogus"], /--bogus/],
    [["--course", "1", "--dest"], /--dest/],
    [["--course", "1", "--dest", "/tmp/x", "stray"], /stray/],
  ])("rejects %j as a usage error", (argv, message) => {
    const parsed = parseSyncArgs(argv);
    expect(parsed).toMatchObject({ error: expect.stringMatching(message) });
  });

  it("recognises --help", () => {
    expect(parseSyncArgs(["--help"])).toEqual({ help: true });
  });
});

describe("runSync", () => {
  let parent: string;
  let dest: string;
  let fake: Fake;
  let out: string;
  let err: string;
  const io = () => ({ stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; } });

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    parent = await tempRoot();
    dest = path.join(parent, "dest");
    await fs.mkdir(dest);
    out = "";
    err = "";
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fake?.close();
    await fs.rm(parent, { recursive: true, force: true });
  });

  const toc = { Modules: [module_(1, "Week 1", [fileTopic(10, "/content/enforced/42-C/A.pdf"), fileTopic(11, "/content/enforced/42-C/B.pdf")])] };
  async function go(argv: string[], topics: Record<number, any>, tocOverride: unknown = toc) {
    fake = await fakeBrightspace(tocOverride, topics);
    const code = await runSync(argv, io(), { createClient: async () => fake.client, sleep: async () => {} });
    return code;
  }

  it("exits 0 and prints a summary after a full success", async () => {
    const code = await go(["--course", "42", "--dest", dest], { 10: { body: pdf("a") }, 11: { body: pdf("b") } });
    expect(code).toBe(0);
    expect(out).toMatch(/2 downloaded/);
    expect(await fs.readdir(path.join(dest, "Week 1"))).toEqual(["A.pdf", "B.pdf"]);
  });

  it("with --json prints only one JSON object on stdout and human lines on stderr", async () => {
    const code = await go(["--course", "42", "--dest", dest, "--json"], { 10: { body: pdf("a") }, 11: { body: pdf("b") } });
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ courseId: 42, destination: dest, skippedExisting: 0, notAttempted: 0 });
    expect(parsed.downloaded).toEqual([{ path: "Week 1/A.pdf", bytes: pdf("a").length }, { path: "Week 1/B.pdf", bytes: pdf("b").length }]);
    expect(parsed.nonFiles).toEqual({ link: 0, media: 0, broken: 0, other: 0, unavailable: 0 });
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(err).toMatch(/Week 1\/A\.pdf/);
  });

  it("exits 1 when a file failed", async () => {
    const code = await go(["--course", "42", "--dest", dest, "--json"], { 10: { body: pdf("a") }, 11: { status: 404 } });
    expect(code).toBe(1);
    expect(JSON.parse(out).failed).toHaveLength(1);
  });

  it("exits 1 when files were not attempted", async () => {
    const code = await go(["--course", "42", "--dest", dest, "--max-files", "1", "--json"], { 10: { body: pdf("a") }, 11: { body: pdf("b") } });
    expect(code).toBe(1);
    expect(JSON.parse(out).notAttempted).toBe(1);
  });

  it("exits 1 with the sign-in guidance when the session is gone", async () => {
    const code = await go(["--course", "42", "--dest", dest], { 10: { status: 401 } });
    expect(code).toBe(1);
    expect(out + err).toMatch(/auth/i);
  });

  it("exits 0 on a rerun that finds nothing new", async () => {
    await go(["--course", "42", "--dest", dest], { 10: { body: pdf("a") }, 11: { body: pdf("b") } });
    await fake.close();
    out = "";
    const code = await go(["--course", "42", "--dest", dest, "--json"], {});
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ skippedExisting: 2, downloaded: [] });
  });

  it("a dry run exits 0, lists the plan and writes nothing, even to a destination that does not exist yet", async () => {
    const missing = path.join(parent, "later");
    const code = await go(["--course", "42", "--dest", missing, "--dry-run", "--json"], {});
    expect(code).toBe(0);
    expect(JSON.parse(out).planned).toEqual(["Week 1/A.pdf", "Week 1/B.pdf"]);
    await expect(fs.access(missing)).rejects.toThrow();
  });

  it("creates a missing destination for a real run", async () => {
    const fresh = path.join(parent, "fresh", "nested");
    const code = await go(["--course", "42", "--dest", fresh], { 10: { body: pdf("a") }, 11: { body: pdf("b") } });
    expect(code).toBe(0);
    expect(await fs.readdir(path.join(fresh, "Week 1"))).toHaveLength(2);
  });

  it.each([
    [["--course", "42"], false],
    [["--course", "42", "--dest", "/x", "--bogus", "--json"], true],
  ])("exits 2 on a usage error %j and prints the usage on stderr", async (argv) => {
    fake = await fakeBrightspace(toc, {});
    const create = vi.fn(async () => fake.client);
    const code = await runSync(argv, io(), { createClient: create });
    expect(code).toBe(2);
    expect(create).not.toHaveBeenCalled();
    expect(err).toContain("Usage:");
    expect(out).toBe("");
  });

  it("exits 2 for an unknown module and says so as JSON under --json", async () => {
    const code = await go(["--course", "42", "--dest", dest, "--module", "999", "--json"], {});
    expect(code).toBe(2);
    expect(JSON.parse(out).error).toMatch(/Module 999/);
  });

  it("exits 1 when Brightspace cannot be reached for the contents", async () => {
    fake = await fakeBrightspace(toc, {});
    fake.client.get.mockRejectedValue(new Error("boom"));
    const code = await runSync(["--course", "42", "--dest", dest], io(), { createClient: async () => fake.client });
    expect(code).toBe(1);
    expect(err).toMatch(/could not|failed/i);
  });

  it("prints usage on stdout and exits 0 for --help", async () => {
    const code = await runSync(["--help"], io(), { createClient: async () => { throw new Error("no"); } });
    expect(code).toBe(0);
    expect(out).toBe(SYNC_USAGE);
  });

  it("documents every flag in the usage", () => {
    for (const flag of ["--course", "--dest", "--existing", "--module", "--dry-run", "--json", "--max-files"]) expect(SYNC_USAGE).toContain(flag);
  });
});
