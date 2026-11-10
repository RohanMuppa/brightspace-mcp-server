import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LOCK_NAME, MANIFEST_NAME } from "../../src/sync/manifest.js";
import { SyncInputError, locateFolder, syncCourse, type SyncOptions, type SyncProgress } from "../../src/sync/course-sync.js";
import { fakeBrightspace, fileTopic, listTree, module_, pdf, tempRoot, type Fake, type Step } from "./harness.js";

let parent: string;
let root: string;
let fake: Fake | undefined;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  parent = await tempRoot();
  root = path.join(parent, "dest");
  await fs.mkdir(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake?.close();
  fake = undefined;
  await fs.rm(parent, { recursive: true, force: true });
});

const ok = (tag = "x", pad = 64): Step => ({ body: pdf(tag, pad) });
const cfb = (): Buffer => Buffer.concat([Buffer.from("D0CF11E0A1B11AE1", "hex"), Buffer.alloc(600, 1)]);
const url = (name: string) => `/content/enforced/42-C/${encodeURIComponent(name)}`;

async function run(toc: unknown, topics: Record<number, Step | Step[]>, options: Partial<SyncOptions> = {}) {
  fake = await fakeBrightspace(toc, topics);
  const result = await syncCourse(fake.client, { courseId: 42, destination: root, sleep: async () => {}, ...options });
  await fake.close();
  const used = fake;
  fake = undefined;
  return { result, fake: used };
}

describe("dot names", () => {
  it("cannot create dot-folders or dot-files in the destination, even with existing: replace", async () => {
    // The destination stands in for a home directory.
    await fs.writeFile(path.join(root, ".zshrc"), "MY SHELL CONFIG");
    await fs.mkdir(path.join(root, ".ssh"));
    await fs.writeFile(path.join(root, ".ssh", "authorized_keys"), "MY KEYS");
    const toc = { Modules: [module_(1, ".ssh", [fileTopic(10, url("authorized_keys")), fileTopic(11, url("config"))])], Topics: [fileTopic(12, url(".zshrc"))] };
    const { result } = await run(toc, { 10: ok("1"), 11: ok("2"), 12: ok("3") }, { existing: "replace" });
    expect(await fs.readFile(path.join(root, ".zshrc"), "utf8")).toBe("MY SHELL CONFIG");
    expect(await fs.readFile(path.join(root, ".ssh", "authorized_keys"), "utf8")).toBe("MY KEYS");
    expect(await fs.readdir(path.join(root, ".ssh"))).toEqual(["authorized_keys"]);
    expect(result.downloaded.map((f) => f.path).sort()).toEqual(["_.ssh/authorized_keys", "_.ssh/config", "_.zshrc"]);
    const topLevel = (await fs.readdir(root)).filter((n) => n.startsWith(".") && n !== MANIFEST_NAME);
    expect(topLevel.sort()).toEqual([".ssh", ".zshrc"]);
  });
});

describe("manifest: files this sync wrote", () => {
  const xlsToc = { Modules: [module_(1, "M", [fileTopic(5, url("Grades.xlsx"))])] };
  const xls: Step = { body: cfb(), disposition: 'attachment; filename="Grades.xls"' };

  it("finds an extension-corrected file again instead of downloading Grades (1).xls on every run", async () => {
    const first = await run(xlsToc, { 5: xls });
    expect(first.result.downloaded.map((f) => f.path)).toEqual(["M/Grades.xls"]);
    for (let i = 0; i < 2; i++) {
      const again = await run(xlsToc, { 5: xls });
      expect(again.result.downloaded).toEqual([]);
      expect(again.result.skippedExisting).toBe(1);
      expect(again.fake.requests.size).toBe(0);
    }
    expect(await listTree(root)).toEqual(["M/", "M/Grades.xls"]);
  });

  it("records what it wrote in a manifest in the destination root", async () => {
    await run(xlsToc, { 5: xls });
    const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST_NAME), "utf8"));
    const onDisk = await fs.stat(path.join(root, "M", "Grades.xls"));
    expect(manifest.courses["42"]["5"]).toEqual({ path: "M/Grades.xls", bytes: cfb().length, size: onDisk.size, mtimeMs: onDisk.mtimeMs });
    expect((await fs.readdir(root)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("keeps the right topic when a new same-name topic is added ahead of it", async () => {
    const before = { Modules: [module_(1, "M", [fileTopic(10, url("Notes.pdf"))])] };
    await run(before, { 10: ok("ten") });
    const after = { Modules: [module_(1, "M", [fileTopic(11, url("Notes.pdf")), fileTopic(10, url("Notes.pdf"))])] };
    const { result } = await run(after, { 10: ok("ten"), 11: ok("eleven", 300) });
    expect(result.skippedExisting).toBe(1);
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/Notes (2).pdf"]);
    expect(await fs.readFile(path.join(root, "M", "Notes.pdf"))).toEqual(pdf("ten"));
    const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST_NAME), "utf8"));
    expect(manifest.courses["42"]["10"].path).toBe("M/Notes.pdf");
    expect(manifest.courses["42"]["11"].path).toBe("M/Notes (2).pdf");
  });

  it("downloads a topic again when its recorded file was deleted", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf"))])] };
    await run(toc, { 10: ok("a") });
    await fs.rm(path.join(root, "M", "A.pdf"));
    const { result } = await run(toc, { 10: ok("a") });
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/A.pdf"]);
  });

  it("does not replace an unplanned sibling when an extension is corrected under replace", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(1, "/x/a.pdf")])] };
    await run(toc, { 1: ok("first") });
    await fs.writeFile(path.join(root, "M", "a.xls"), "USER DATA");
    const { result } = await run(toc, { 1: { body: cfb(), disposition: 'attachment; filename="z.xls"' } }, { existing: "replace" });
    expect(await fs.readFile(path.join(root, "M", "a.xls"), "utf8")).toBe("USER DATA");
    expect(result.downloaded).toHaveLength(1);
    expect(result.downloaded[0].path).not.toBe("M/a.xls");
    expect(result.failed).toEqual([]);
  });

  it("ignores a manifest entry that points outside the destination", async () => {
    const outside = path.join(parent, "victim.pdf");
    await fs.writeFile(outside, "VICTIM");
    await fs.writeFile(path.join(root, MANIFEST_NAME), JSON.stringify({ courses: { 42: { 10: { path: "../victim.pdf", bytes: 6 } } } }));
    const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf"))])] };
    const { result } = await run(toc, { 10: ok("a") }, { existing: "replace" });
    expect(await fs.readFile(outside, "utf8")).toBe("VICTIM");
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/A.pdf"]);
  });

  it.runIf(process.platform !== "win32")("writes the manifest readable only by the user", async () => {
    await run(xlsToc, { 5: xls });
    expect((await fs.stat(path.join(root, MANIFEST_NAME))).mode & 0o777).toBe(0o600);
  });

  it("a dry run writes no manifest and no lock", async () => {
    await run(xlsToc, { 5: xls }, { dryRun: true });
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("lock", () => {
  const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf"))])] };

  it("refuses a second sync into a destination that a running one holds", async () => {
    await fs.writeFile(path.join(root, LOCK_NAME), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    fake = await fakeBrightspace(toc, { 10: ok() });
    await expect(syncCourse(fake.client, { courseId: 42, destination: root })).rejects.toThrow(/already running/);
    expect(fake.requests.size).toBe(0);
    expect(fake.tocReads()).toBe(0);
    // The holder's lock is not removed by the refused one.
    expect(await fs.readdir(root)).toEqual([LOCK_NAME]);
  });

  it("two overlapping syncs: one runs, one is refused", async () => {
    fake = await fakeBrightspace(toc, { 10: ok() });
    const outcomes = await Promise.allSettled([
      syncCourse(fake.client, { courseId: 42, destination: root }),
      syncCourse(fake.client, { courseId: 42, destination: root }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(SyncInputError);
  });

  it("releases the lock when the run ends, even by an error", async () => {
    await run(toc, { 10: ok() });
    expect(await fs.readdir(root)).not.toContain(LOCK_NAME);
    fake = await fakeBrightspace(toc, {});
    await expect(syncCourse(fake.client, { courseId: 42, destination: root, moduleId: 999 })).rejects.toThrow(/Module 999/);
    expect(await fs.readdir(root)).not.toContain(LOCK_NAME);
  });

  it("takes over the lock of a dead process", async () => {
    await fs.writeFile(path.join(root, LOCK_NAME), JSON.stringify({ pid: 2 ** 31 - 2, startedAt: Date.now() }));
    const { result } = await run(toc, { 10: ok() });
    expect(result.downloaded).toHaveLength(1);
  });
});

describe("cancel, deadline and progress", () => {
  const toc = { Modules: [module_(1, "M", Array.from({ length: 6 }, (_, i) => fileTopic(10 + i, url(`f${i}.pdf`))))] };
  const all = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [10 + i, ok(`f${i}`)]));

  it("reports progress for every file with a running count and the total", async () => {
    const events: SyncProgress[] = [];
    await run(toc, all, { onProgress: (e) => events.push(e) });
    expect(events).toHaveLength(6);
    expect(events.map((e) => e.done)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(events.map((e) => e.total))).toEqual(new Set([6]));
    expect(events.every((e) => e.type === "downloaded")).toBe(true);
  });

  it("stops when the caller aborts and reports the rest as not attempted", async () => {
    const controller = new AbortController();
    const { result } = await run(toc, all, {
      signal: controller.signal,
      onProgress: (e) => { if (e.done === 2) controller.abort(); },
    });
    expect(result.downloaded).toHaveLength(2);
    expect(result.notAttempted).toBe(4);
    expect(result.stopped).toBe("cancelled");
    expect(result.failed).toEqual([]);
  });

  it("does nothing when the signal is already aborted", async () => {
    const { result, fake: used } = await run(toc, all, { signal: AbortSignal.abort() });
    expect(result.downloaded).toEqual([]);
    expect(used.requests.size).toBe(0);
    expect(result.stopped).toBe("cancelled");
  });

  it("stops cleanly at the wall-clock deadline", async () => {
    fake = await fakeBrightspace(toc, all);
    const slow = fake.client.getRaw.getMockImplementation()!;
    fake.client.getRaw.mockImplementation(async (p: string) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return slow(p);
    });
    const result = await syncCourse(fake.client, { courseId: 42, destination: root, deadlineMs: 100 });
    expect(result.stopped).toBe("deadline");
    expect(result.downloaded.length).toBeGreaterThan(0);
    expect(result.downloaded.length + result.notAttempted).toBe(6);
    expect(result.notAttempted).toBeGreaterThan(0);
    expect(result.failed).toEqual([]);
    // Nothing half-written is left behind.
    expect((await fs.readdir(path.join(root, "M"))).filter((n) => n.endsWith(".part"))).toEqual([]);
  });
});

describe("bounds", () => {
  it("stops at maxTotalBytes using Content-Length before writing the file that would pass it", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf")), fileTopic(12, url("C.pdf"))])] };
    const size = pdf("a", 1000).length;
    const { result, fake: used } = await run(toc, { 10: ok("a", 1000), 11: ok("b", 1000), 12: ok("c", 1000) }, { maxTotalBytes: size * 2 - 10 });
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/A.pdf"]);
    expect(result.notAttempted).toBe(2);
    expect(result.stopped).toBe("max_total_bytes");
    expect(await listTree(root)).toEqual(["M/", "M/A.pdf"]);
    expect(used.requests.get(12)).toBeUndefined();
  });

  it("stops once the budget is reached exactly", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf"))])] };
    const size = pdf("a", 100).length;
    const { result } = await run(toc, { 10: ok("a", 100), 11: ok("b", 100) }, { maxTotalBytes: size });
    expect(result.downloaded).toHaveLength(1);
    expect(result.stopped).toBe("max_total_bytes");
  });

  it("rejects a non-positive byte budget", async () => {
    fake = await fakeBrightspace({ Modules: [] }, {});
    await expect(syncCourse(fake.client, { courseId: 42, destination: root, maxTotalBytes: 0 })).rejects.toThrow(SyncInputError);
  });

  it("cuts off a table of contents of an absurd size and says so", async () => {
    const topics = Array.from({ length: 50_500 }, (_, i) => fileTopic(1000 + i, url(`f${i}.pdf`)));
    const { result } = await run({ Modules: [module_(1, "M", topics)] }, {}, { dryRun: true, maxFiles: 5 });
    expect(result.tocTruncated).toBe(true);
    expect(result.planned).toHaveLength(5);
  });

  it("cuts off modules nested absurdly deep and says so", async () => {
    let nested: any = module_(99, "leaf", [fileTopic(10, url("A.pdf"))]);
    for (let i = 0; i < 60; i++) nested = module_(i + 1, `m${i}`, [], [nested]);
    const { result } = await run({ Modules: [nested] }, { 10: ok() }, { dryRun: true });
    expect(result.tocTruncated).toBe(true);
  });
});

describe("path length", () => {
  it("shortens names so every full path fits the budget", async () => {
    const long = "x".repeat(140);
    const toc = { Modules: [module_(1, long, [fileTopic(10, url(`${long}.pdf`))], [module_(2, `${long}2`, [fileTopic(11, url(`${long}3.pdf`))])])] };
    const budget = root.length + 90;
    const { result } = await run(toc, { 10: ok("a"), 11: ok("b") }, { pathBudget: budget });
    expect(result.failed).toEqual([]);
    expect(result.downloaded).toHaveLength(2);
    for (const f of result.downloaded) {
      expect(path.join(root, f.path).length).toBeLessThanOrEqual(budget);
      expect(f.path.endsWith(".pdf")).toBe(true);
    }
  });

  it("reports a file whose path cannot be shortened enough as too long, not as an unexpected error", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf"))])] };
    const { result } = await run(toc, { 10: ok() }, { pathBudget: root.length + 5 });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/too long/i);
  });

  it("maps a path the filesystem refuses to a too-long failure", async () => {
    let nested: any = module_(99, "leaf", [fileTopic(10, url("A.pdf"))]);
    for (let i = 0; i < 30; i++) nested = module_(i + 1, `${i}${"y".repeat(147)}`, [], [nested]);
    const { result } = await run({ Modules: [nested] }, { 10: ok() });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/too long/i);
    expect(result.failed[0].error).not.toMatch(/unexpected/i);
  });
});

describe("locateFolder containment", () => {
  it.runIf(process.platform !== "win32")("accepts a filesystem-root destination", async () => {
    expect(await locateFolder("/", ["usr"], false)).toBe(path.join("/", "usr"));
  });

  it("accepts a folder whose name merely starts with two dots", async () => {
    await fs.mkdir(path.join(root, "..foo"));
    expect(await locateFolder(root, ["..foo"], false)).toBe(path.join(root, "..foo"));
  });

  it.each([[".."], ["a/b"], [""], ["."]])("refuses the segment %j", async (segment) => {
    await expect(locateFolder(root, [segment], false)).rejects.toThrow(/outside the destination/);
  });
});

describe("protected destinations", () => {
  const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf"))])] };

  it.each([
    ["the home directory", () => os.homedir()],
    ["a credential folder inside home", () => path.join(os.homedir(), ".ssh")],
    ["the filesystem root", () => path.parse(process.cwd()).root],
    ["a system folder", () => (process.platform === "win32" ? "C:\\Windows" : "/etc")],
  ])("refuses %s, for a real run and a dry run, before reading the course", async (_label, destination) => {
    fake = await fakeBrightspace(toc, { 10: ok() });
    for (const dryRun of [false, true]) {
      await expect(syncCourse(fake.client, { courseId: 42, destination: destination(), dryRun })).rejects.toThrow(/Cannot save into/);
    }
    expect(fake.tocReads()).toBe(0);
    expect(fake.requests.size).toBe(0);
  });
});

describe("replace never overwrites a synced file the user has since changed", () => {
  const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf"))])] };
  const target = () => path.join(root, "M", "A.pdf");
  const synced = async () => {
    await run(toc, { 10: ok("v1") });
  };

  it("replaces an untouched synced file", async () => {
    await synced();
    const fresh = pdf("v2", 300);
    const { result } = await run(toc, { 10: { body: fresh } }, { existing: "replace" });
    expect(result.downloaded).toHaveLength(1);
    expect(await fs.readFile(target())).toEqual(fresh);
  });

  it("skips a file whose size changed (annotations added)", async () => {
    await synced();
    const annotated = Buffer.concat([pdf("v1"), Buffer.from("MY ANNOTATIONS")]);
    await fs.writeFile(target(), annotated);
    const { result, fake: used } = await run(toc, { 10: ok("v2", 300) }, { existing: "replace" });
    expect(result.skippedExisting).toBe(1);
    expect(result.downloaded).toEqual([]);
    expect(await fs.readFile(target())).toEqual(annotated);
    expect(used.requests.size).toBe(0);
  });

  it("skips a file edited to the same size, because its modification time moved", async () => {
    await synced();
    const same = Buffer.from(pdf("v1"));
    same[12] = same[12] ^ 1;
    await fs.writeFile(target(), same);
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(target(), later, later);
    const { result } = await run(toc, { 10: ok("v2", 300) }, { existing: "replace" });
    expect(result.skippedExisting).toBe(1);
    expect(await fs.readFile(target())).toEqual(same);
  });

  it("under keep_both, saves the new copy beside an edited file", async () => {
    await synced();
    const annotated = Buffer.concat([pdf("v1"), Buffer.from("MY ANNOTATIONS")]);
    await fs.writeFile(target(), annotated);
    const { result } = await run(toc, { 10: ok("v2", 900) }, { existing: "keep_both" });
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/A (1).pdf"]);
    expect(await fs.readFile(target())).toEqual(annotated);
  });

  it("does not replace a file named by an entry that was written by hand", async () => {
    const mine = pdf("my own");
    await fs.mkdir(path.join(root, "M"));
    await fs.writeFile(target(), mine);
    const stat = await fs.stat(target());
    for (const entry of [
      { path: "M/A.pdf", bytes: mine.length },
      { path: "M/A.pdf", bytes: mine.length, size: mine.length + 1, mtimeMs: stat.mtimeMs },
      { path: "M/A.pdf", bytes: mine.length, size: mine.length, mtimeMs: stat.mtimeMs - 5000 },
    ]) {
      await fs.writeFile(path.join(root, MANIFEST_NAME), JSON.stringify({ courses: { 42: { 10: entry } } }));
      const { result } = await run(toc, { 10: ok("v2", 300) }, { existing: "replace" });
      expect(result.skippedExisting).toBe(1);
      expect(await fs.readFile(target())).toEqual(mine);
    }
  });

  it("still finds a file from an entry with no recorded state, but never replaces it", async () => {
    await synced();
    const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST_NAME), "utf8"));
    delete manifest.courses["42"]["10"].size;
    delete manifest.courses["42"]["10"].mtimeMs;
    await fs.writeFile(path.join(root, MANIFEST_NAME), JSON.stringify(manifest));
    expect((await run(toc, {})).result.skippedExisting).toBe(1);
    const { result } = await run(toc, { 10: ok("v2", 300) }, { existing: "replace" });
    expect(result.skippedExisting).toBe(1);
    expect(result.downloaded).toEqual([]);
  });
});
