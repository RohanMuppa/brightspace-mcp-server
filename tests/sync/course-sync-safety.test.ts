import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../../src/utils/atomic-write.js";
import { LOCK_NAME, MANIFEST_NAME } from "../../src/sync/manifest.js";
import { SyncInputError, locateFolder, syncCourse, type SyncOptions, type SyncProgress } from "../../src/sync/course-sync.js";
import { fakeBrightspace, fileTopic, listTree, module_, pdf, tempRoot, type Fake, type Step } from "./harness.js";

// Wrapped so the number of manifest writes can be counted; it still writes for real.
vi.mock("../../src/utils/atomic-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/atomic-write.js")>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

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

describe("an abort interrupts a request that is hung", () => {
  const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf"))])] };
  /** A request that never answers but ends when its signal aborts, as fetch does. */
  const hangs = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

  it("ends a hung file download at the deadline and reports the rest as not attempted", async () => {
    fake = await fakeBrightspace(toc, { 10: ok("a"), 11: ok("b") });
    fake.client.getRaw.mockImplementation((_p: string, options?: { signal?: AbortSignal }) => hangs(options?.signal));
    const started = Date.now();
    const result = await syncCourse(fake.client, { courseId: 42, destination: root, deadlineMs: 60 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.stopped).toBe("deadline");
    expect(result.downloaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.notAttempted).toBe(2);
  });

  it("ends a hung table-of-contents read at the deadline", async () => {
    fake = await fakeBrightspace(toc, {});
    fake.client.get.mockImplementation((_p: string, options?: { signal?: AbortSignal }) => hangs(options?.signal));
    const result = await syncCourse(fake.client, { courseId: 42, destination: root, deadlineMs: 60 });
    expect(result.stopped).toBe("deadline");
    expect(result.downloaded).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("passes the signal to the client for both requests", async () => {
    fake = await fakeBrightspace(toc, { 10: ok("a"), 11: ok("b") });
    await syncCourse(fake.client, { courseId: 42, destination: root });
    expect(fake.client.get.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fake.client.getRaw.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("ends a backoff wait at once when the caller cancels", async () => {
    fake = await fakeBrightspace(toc, { 10: { status: 408 }, 11: ok("b") });
    const controller = new AbortController();
    const result = await syncCourse(fake.client, {
      courseId: 42,
      destination: root,
      signal: controller.signal,
      // A pause that would never end on its own; the cancel arrives while it is waiting.
      sleep: () => { setTimeout(() => controller.abort(), 10); return new Promise<void>(() => {}); },
    });
    expect(result.stopped).toBe("cancelled");
    expect(result.failed).toEqual([]);
    expect(result.notAttempted).toBe(2);
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
  }, 60_000);

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

  it("saves a copy instead when the file is edited between the decision and the overwrite", async () => {
    await synced();
    fake = await fakeBrightspace(toc, { 10: ok("v2", 300) });
    const annotated = Buffer.concat([pdf("v1"), Buffer.from("ANNOTATED WHILE DOWNLOADING")]);
    const serve = fake.client.getRaw.getMockImplementation()!;
    // The user saves their annotations after the sync planned the replace and before it renames.
    fake.client.getRaw.mockImplementation(async (p: string, o: unknown) => {
      const response = await serve(p, o);
      await fs.writeFile(target(), annotated);
      return response;
    });
    const result = await syncCourse(fake.client, { courseId: 42, destination: root, existing: "replace", sleep: async () => {} });
    expect(await fs.readFile(target())).toEqual(annotated);
    expect(result.downloaded).toHaveLength(1);
    expect(result.downloaded[0].path).not.toBe("M/A.pdf");
    expect(await fs.readFile(path.join(root, result.downloaded[0].path))).toEqual(pdf("v2", 300));
    expect(result.failed).toEqual([]);
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

describe("names on disk: what the filesystem treats as one name", () => {
  it("numbers a file whose name folds to a module folder's name, and a rerun is clean", async () => {
    const toc = { Modules: [module_(1, "SS", [fileTopic(10, url("A.pdf"))])], Topics: [fileTopic(11, "/content/enforced/42-C/%C3%9F")] };
    const first = await run(toc, { 10: ok("a"), 11: ok("b") });
    expect(first.result.failed).toEqual([]);
    expect(first.result.downloaded.map((f) => f.path).sort()).toEqual(["SS/A.pdf", "ß (2)"]);
    const again = await run(toc, { 10: ok("a"), 11: ok("b") });
    expect(again.result.failed).toEqual([]);
    expect(again.result.skippedExisting).toBe(2);
  });

  it("numbers ß.pdf, SS.pdf and ss.pdf apart on disk", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(1, url("ß.pdf")), fileTopic(2, url("SS.pdf")), fileTopic(3, url("ss.pdf"))])] };
    const { result } = await run(toc, { 1: ok("1"), 2: ok("2"), 3: ok("3") });
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/ß.pdf", "M/SS (2).pdf", "M/ss (3).pdf"]);
  });

  it("sends a sanitised module-id fallback through the same cleaning as a title", async () => {
    const toc = { Modules: [{ ModuleId: "../../evil\u0000", Title: "", Topics: [fileTopic(10, url("A.pdf"))], Modules: [] }] };
    const { result } = await run(toc, { 10: ok() });
    expect(result.downloaded).toHaveLength(1);
    expect(result.downloaded[0].path.split("/")).toHaveLength(2);
    expect(await fs.readdir(parent)).toEqual(["dest"]);
  });
});

describe("names: the downloader never decodes a planned name again", () => {
  it("saves a name carrying a literal percent escape exactly as planned", async () => {
    // The Url is "a%2541.pdf": decoded once, "a%41.pdf" is the upload's real name.
    const toc = { Modules: [module_(1, "M", [fileTopic(10, "/content/enforced/42-C/a%2541.pdf")])] };
    const { result } = await run(toc, { 10: ok() });
    expect(result.failed).toEqual([]);
    const saved = result.downloaded[0].path.split("/")[1];
    expect(await fs.readdir(path.join(root, "M"))).toEqual([saved]);
    expect(decodeURIComponent(saved)).toBe(saved);
  });

  it("cannot be turned into a dot-file, '..', a NUL or a backslash by a title escape", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(10, "", { Title: "%2ezshrc" }), fileTopic(11, "", { Title: "%2e%2e" }), fileTopic(12, "", { Title: "a%00b" }), fileTopic(13, "", { Title: "a%5Cb" })])] };
    // A File topic with no Url is broken; give them one with no usable basename.
    for (const m of (toc.Modules[0] as any).Topics) m.Url = "/content/enforced/42-C/";
    const { result } = await run(toc, { 10: ok("1"), 11: ok("2"), 12: ok("3"), 13: ok("4") });
    expect(result.failed).toEqual([]);
    for (const f of await fs.readdir(path.join(root, "M"))) {
      expect(f).not.toMatch(/^\.|\u0000|\\|\//);
      expect(f).not.toBe("..");
    }
    expect(await fs.readdir(root)).not.toContain(".zshrc");
  });
});

describe("failure wording", () => {
  it("names a filename the filesystem rejects (EILSEQ) as a per-file failure, not an unexpected error", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf"))])] };
    const realLink = fs.link;
    const spy = vi.spyOn(fs, "link").mockImplementation((async (from: any, to: any) => {
      if (String(to).endsWith("A.pdf")) throw Object.assign(new Error("illegal byte sequence"), { code: "EILSEQ" });
      return realLink(from, to);
    }) as any);
    try {
      const { result } = await run(toc, { 10: ok("a"), 11: ok("b") });
      expect(result.failed).toEqual([{ path: "M/A.pdf", error: "The file system does not accept this file or folder name" }]);
      expect(result.downloaded.map((f) => f.path)).toEqual(["M/B.pdf"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports a 0-byte file as empty on Brightspace, not as a failure or an error page", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(10, url("Empty.pdf")), fileTopic(11, url("Empty2.pdf")), fileTopic(12, url("B.pdf"))])] };
    const { result } = await run(toc, { 10: { body: Buffer.alloc(0) }, 11: { body: Buffer.alloc(0), noLength: true }, 12: ok("b") });
    expect(result.emptyOnBrightspace).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/B.pdf"]);
    expect(await listTree(root)).toEqual(["M/", "M/B.pdf"]);
    const { summarizeSync } = await import("../../src/sync/summary.js");
    expect(summarizeSync(result)).toMatch(/2 empty files \(0 bytes on Brightspace/);
  });
});

describe("table-of-contents depth", () => {
  const chain = (levels: number, leafModules: unknown[]) => {
    let nested: any = { ModuleId: 999, Title: "leaf", Topics: [fileTopic(10, url("A.pdf"))], Modules: leafModules };
    for (let i = 1; i < levels; i++) nested = module_(i, `m${i}`, [], [nested]);
    return { Modules: [nested] };
  };

  it("is not truncated when the deepest level ends in an empty list of modules", async () => {
    const { result } = await run(chain(32, []), { 10: ok() }, { dryRun: true });
    expect(result.tocTruncated).toBeUndefined();
    expect(result.planned).toHaveLength(1);
  });

  it("is truncated when modules really continue past the limit", async () => {
    const { result } = await run(chain(32, [module_(500, "beyond", [fileTopic(11, url("B.pdf"))])]), { 10: ok() }, { dryRun: true });
    expect(result.tocTruncated).toBe(true);
  });
});

describe("byte budget without Content-Length", () => {
  it("holds when the server states no length: the stream is cut and the file is not kept", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf"))])] };
    const size = pdf("a", 1000).length;
    const { result } = await run(toc, { 10: { body: pdf("a", 1000), noLength: true }, 11: { body: pdf("b", 1000), noLength: true } }, { maxTotalBytes: size - 100 });
    expect(result.downloaded).toEqual([]);
    expect(result.stopped).toBe("max_total_bytes");
    expect(result.notAttempted).toBe(2);
    expect(result.failed).toEqual([]);
    expect((await listTree(root)).filter((entry) => !entry.endsWith("/"))).toEqual([]);
  });

  it("lets a file that exactly fits the remaining budget through", async () => {
    const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf"))])] };
    const size = pdf("a", 1000).length;
    const { result } = await run(toc, { 10: { body: pdf("a", 1000), noLength: true } }, { maxTotalBytes: size });
    expect(result.downloaded).toHaveLength(1);
  });
});

describe("manifest writes are batched", () => {
  it("writes it every 25 files and at the end, not after every file, and it lists all of them", async () => {
    const topics = Array.from({ length: 60 }, (_, i) => fileTopic(100 + i, url(`f${i}.pdf`)));
    const plan = Object.fromEntries(topics.map((t, i) => [100 + i, ok(`f${i}`)]));
    vi.mocked(writeFileAtomic).mockClear();
    await run({ Modules: [module_(1, "M", topics)] }, plan);
    const writes = vi.mocked(writeFileAtomic).mock.calls.filter(([target]) => String(target).endsWith(MANIFEST_NAME)).length;
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(writes).toBeLessThanOrEqual(5);
    const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST_NAME), "utf8"));
    expect(Object.keys(manifest.courses["42"])).toHaveLength(60);
  });

  it("is written when the run stops early, so nothing downloaded is forgotten", async () => {
    const topics = Array.from({ length: 6 }, (_, i) => fileTopic(100 + i, url(`f${i}.pdf`)));
    const plan = Object.fromEntries(topics.map((t, i) => [100 + i, ok(`f${i}`)]));
    const controller = new AbortController();
    await run({ Modules: [module_(1, "M", topics)] }, plan, { signal: controller.signal, onProgress: (e) => { if (e.done === 3) controller.abort(); } });
    const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST_NAME), "utf8"));
    expect(Object.keys(manifest.courses["42"])).toHaveLength(3);
  });
});
