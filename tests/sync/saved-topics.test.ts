import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { registerDownloadFile, settleSavedTopicRecords } from "../../src/tools/download-file.js";
import { registerDownloadCourseFiles } from "../../src/tools/download-course-files.js";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";
import { registerGetUnsavedCourseFiles } from "../../src/tools/get-unsaved-course-files.js";
import { FIND_NEW_FILES_GUIDANCE } from "../../src/tools/tool-helpers.js";
import { readSavedState, recordSyncRoot, useLedgerFile } from "../../src/sync/saved-topics.js";
import { SyncManifest } from "../../src/sync/manifest.js";
import { ApiError } from "../../src/api/errors.js";
import { fakeBrightspace, fileTopic, module_, pdf, tempRoot, type Fake } from "./harness.js";

const ORIGIN = "https://school.brightspace.test";
const COURSE = 42;

let dir: string;
let ledger: string;
let fake: Fake;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await tempRoot();
  ledger = path.join(dir, "state", "saved-topics.json");
  await fs.mkdir(path.dirname(ledger));
  useLedgerFile(ledger);
});
afterEach(async () => {
  useLedgerFile();
  vi.restoreAllMocks();
  await fake?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const toc = {
  Modules: [
    module_(1, "Homework", [
      fileTopic(10, "/content/enforced/42-C/HW11.pdf"),
      fileTopic(12, "/content/enforced/42-C/HW12.pdf"),
      { TopicId: 13, TypeIdentifier: "Link", TopicType: 3, Title: "A link" },
    ]),
  ],
};
const bodies = { 10: { body: pdf("a") }, 12: { body: pdf("b") } };

/** Runs a tool, then waits for any ledger write the answer stopped waiting for, so the next read sees it. */
const settled = async (response: Promise<unknown>): Promise<any> => {
  const value = await response;
  await settleSavedTopicRecords();
  return value;
};
/** Registers a tool and hands back its config and handler. */
function tool(register: (server: never, client: never) => void) {
  let config: any;
  let handler: any;
  register({ registerTool: (_n: string, c: unknown, f: any) => { config = c; handler = f; } } as never, fake.client as never);
  return {
    config,
    call: (args: Record<string, unknown>, extra?: unknown) => settled(handler(args, extra)),
    /** Without the wait, for a test that times the answer itself. */
    callRaw: (args: Record<string, unknown>, extra?: unknown) => handler(args, extra),
  };
}
const downloadFile = () => tool(registerDownloadFile as never);
const unsaved = () => tool(registerGetUnsavedCourseFiles as never);
const json = (response: any) => JSON.parse(response.content[0].text);

/** Saves a topic the way the student does: into their own layout, under their own name. */
async function saveOwnLayout(topicId: number, folder: string, name: string): Promise<string> {
  const target = path.join(dir, folder);
  await fs.mkdir(target, { recursive: true });
  const response = await downloadFile().call({ courseId: COURSE, topicId, downloadPath: target, customFilename: name });
  expect(response.isError).toBeUndefined();
  return json(response).filePath;
}

describe("download_file records the topic it saves", () => {
  it("records a content topic saved with downloadPath and customFilename into the student's own layout", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const saved = await saveOwnLayout(12, "ECE 20002/homework/HW12", "HW12 - Problems.pdf");
    expect(path.basename(saved)).toBe("HW12 - Problems.pdf");

    const state = await readSavedState(ORIGIN, COURSE);
    expect(state.unreadable).toEqual([]);
    const [entry] = state.topics.get(12)!;
    expect(entry.path).toBe(saved);
    expect(entry.size).toBe(pdf("b").length);
    expect(Number.isNaN(Date.parse(entry.savedAt!))).toBe(false);
    expect(state.topics.has(10)).toBe(false);
  });

  it("does not record an inline read, which saves nothing", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await downloadFile().call({ courseId: COURSE, topicId: 12 });
    expect((await readSavedState(ORIGIN, COURSE)).topics.size).toBe(0);
  });

  it("still reports a successful download when the ledger cannot be written", async () => {
    fake = await fakeBrightspace(toc, bodies);
    // The ledger's folder is a file, so every write fails.
    await fs.writeFile(path.join(dir, "blocker"), "x");
    useLedgerFile(path.join(dir, "blocker", "saved-topics.json"));
    const target = path.join(dir, "out");
    await fs.mkdir(target);
    const response = await downloadFile().call({ courseId: COURSE, topicId: 12, downloadPath: target });
    expect(response.isError).toBeUndefined();
    expect(json(response).success).toBe(true);
    expect((await fs.readdir(target)).length).toBe(1);
  });
});

describe("get_unsaved_course_files", () => {
  it("is read-only, and its description sends the agent here instead of to modifiedSince", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const { config } = unsaved();
    expect(config.annotations?.readOnlyHint).toBe(true);
    expect(config.description).toContain(FIND_NEW_FILES_GUIDANCE);
  });

  it("lists a topic that was never saved", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.complete).toBe(true);
    expect(result.unsaved.map((t: any) => t.topicId)).toEqual([10, 12]);
    expect(result.unsaved[1]).toMatchObject({ topicId: 12, fileName: "HW12.pdf", modulePath: ["Homework"] });
    expect(result.savedCount).toBe(0);
    expect(result.notice).toBeUndefined();
  });

  it("omits a topic that download_file saved into the student's own layout", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await saveOwnLayout(12, "ECE 20002/homework/HW12", "HW12 - Problems.pdf");
    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.unsaved.map((t: any) => t.topicId)).toEqual([10]);
    expect(result.savedCount).toBe(1);
    expect(result.savedFileMissing).toEqual([]);
  });

  it("flags a saved topic whose file was deleted, and counts it as not saved", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const saved = await saveOwnLayout(12, "ECE 20002/homework/HW12", "HW12 - Problems.pdf");
    await fs.rm(saved);
    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.unsaved.map((t: any) => t.topicId)).toEqual([10]);
    expect(result.savedFileMissing).toEqual([expect.objectContaining({ topicId: 12, savedTo: saved })]);
    expect(result.savedCount).toBe(0);
    expect(result.notice).toMatch(/savedFileMissing/);
  });

  it("treats files saved by download_course_files as saved", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const sync = tool(registerDownloadCourseFiles as never);
    const root = path.join(dir, "course");
    await fs.mkdir(root);
    await sync.call({ courseId: COURSE, downloadPath: root, existing: "skip", maxFiles: 300, maxMinutes: 8, maxTotalMB: 100 });
    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.unsaved).toEqual([]);
    expect(result.savedCount).toBe(2);
    await fs.rm(path.join(root, "Homework", "HW11.pdf"));
    expect(json(await unsaved().call({ courseId: COURSE })).savedFileMissing.map((t: any) => t.topicId)).toEqual([10]);
  });

  it("reads the manifest in downloadPath, for a sync that ran before the ledger existed", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const root = path.join(dir, "old-sync");
    await fs.mkdir(path.join(root, "Homework"), { recursive: true });
    await fs.writeFile(path.join(root, "Homework", "HW11.pdf"), pdf("a"));
    await fs.writeFile(path.join(root, ".brightspace-sync.json"), JSON.stringify({ version: 1, courses: { [COURSE]: { 10: { path: "Homework/HW11.pdf", bytes: 1 } } } }));
    expect(json(await unsaved().call({ courseId: COURSE })).unsaved.map((t: any) => t.topicId)).toEqual([10, 12]);
    const result = json(await unsaved().call({ courseId: COURSE, syncFolder: root }));
    expect(result.unsaved.map((t: any) => t.topicId)).toEqual([12]);
  });

  it("keeps one school's saves from hiding another's topic with the same ids", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await saveOwnLayout(12, "mine", "HW12.pdf");
    fake.client.origin = "https://other.brightspace.test";
    expect(json(await unsaved().call({ courseId: COURSE })).unsaved.map((t: any) => t.topicId)).toEqual([10, 12]);
  });

  it("limits the answer to one module", async () => {
    const two = { Modules: [module_(1, "A", [fileTopic(10, "/content/enforced/42-C/a.pdf")]), module_(2, "B", [fileTopic(12, "/content/enforced/42-C/b.pdf")])] };
    fake = await fakeBrightspace(two, bodies);
    expect(json(await unsaved().call({ courseId: COURSE, moduleId: 2 })).unsaved.map((t: any) => t.topicId)).toEqual([12]);
    const missing = await unsaved().call({ courseId: COURSE, moduleId: 99 });
    expect(missing.isError).toBe(true);
  });

  it("says so, and does not claim nothing is new, when the ledger is unreadable", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await fs.writeFile(ledger, "{ not json");
    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.complete).toBe(false);
    expect(result.stateUnreadable).toEqual([expect.objectContaining({ source: "ledger" })]);
    expect(result.notice).toMatch(/could not be read/i);
    expect(result.notice).toMatch(/may already be saved/i);
    // The topics with no record are still listed, never an empty "nothing new".
    expect(result.unsaved.map((t: any) => t.topicId)).toEqual([10, 12]);
  });

  it("says so when a sync folder's manifest is unreadable", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const root = path.join(dir, "broken");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, ".brightspace-sync.json"), "{ not json");
    const result = json(await unsaved().call({ courseId: COURSE, syncFolder: root }));
    expect(result.complete).toBe(false);
    expect(result.stateUnreadable).toEqual([expect.objectContaining({ source: "manifest" })]);
    expect(result.notice).toMatch(/could not be read/i);
  });

  it("does not turn an unreadable course tree into an empty list", async () => {
    fake = await fakeBrightspace(toc, bodies);
    fake.client.get.mockRejectedValue(new ApiError(500, "/content/toc", "boom"));
    const response = await unsaved().call({ courseId: COURSE });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).not.toContain('"unsaved"');
  });

  it("flags a table of contents that was cut off", async () => {
    // Deeper than the sync reads (32 levels): the plan is cut off and says so.
    let deep: any = module_(99, "deep", [fileTopic(10, "/content/enforced/42-C/a.pdf")]);
    for (let i = 0; i < 40; i++) deep = module_(i, `m${i}`, [], [deep]);
    fake = await fakeBrightspace({ Modules: [deep] }, bodies);
    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.tocTruncated).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.notice).toMatch(/cut off/i);
  });
});

describe("agent-facing descriptions", () => {
  it("tell the agent to diff by topic id and never to infer absence from modifiedSince", async () => {
    fake = await fakeBrightspace(toc, bodies);
    for (const config of [tool(registerGetCourseContent as never).config, downloadFile().config, tool(registerDownloadCourseFiles as never).config]) {
      expect(config.description).toContain("get_unsaved_course_files");
      expect(config.description).toMatch(/never conclude a file is absent/i);
    }
  });
});

const syncArgs = { existing: "skip", maxFiles: 300, maxMinutes: 8, maxTotalMB: 100 };

describe("a damaged ledger stays visible (review item 1)", () => {
  it("reports the set-aside ledger as unreadable state until the student removes it", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await saveOwnLayout(12, "mine", "HW12.pdf");
    await fs.writeFile(ledger, "{ not json");
    await saveOwnLayout(10, "mine", "HW11.pdf");

    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.complete).toBe(false);
    const aside = result.stateUnreadable.find((s: any) => s.where.includes(".corrupt-"));
    expect(aside).toMatchObject({ source: "ledger" });
    expect(aside.reason).toMatch(/earlier saves are unknown/i);
    expect(result.notice).toMatch(/earlier saves are unknown/i);
    expect(result.unsaved.map((t: any) => t.topicId)).toEqual([12]);

    await fs.rm(aside.where);
    const cleared = json(await unsaved().call({ courseId: COURSE }));
    expect(cleared.complete).toBe(true);
    expect(cleared.stateUnreadable).toBeUndefined();
  });

  it("leaves a ledger from a newer version alone, and reports it, without moving it aside", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const future = JSON.stringify({ version: 2, schools: {} });
    await fs.writeFile(ledger, future);
    const target = path.join(dir, "out");
    await fs.mkdir(target);
    await downloadFile().call({ courseId: COURSE, topicId: 12, downloadPath: target });
    expect(await fs.readFile(ledger, "utf8")).toBe(future);
    expect((await fs.readdir(path.dirname(ledger))).filter((n) => n.includes(".corrupt-"))).toEqual([]);
    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.complete).toBe(false);
    expect(result.stateUnreadable).toEqual([expect.objectContaining({ source: "ledger", reason: expect.stringMatching(/version/) })]);
  });
});

describe("several writers keep every entry (review item 2)", () => {
  it("loses nothing when many independent copies of the module write at once", async () => {
    // Each fresh import has its own in-process queue, as a separate server process would.
    const writers: Array<typeof import("../../src/sync/saved-topics.js")> = [];
    for (let i = 0; i < 12; i++) {
      vi.resetModules();
      const copy = await import("../../src/sync/saved-topics.js");
      copy.useLedgerFile(ledger);
      writers.push(copy);
    }
    await Promise.all(writers.map((w, i) => w.recordSavedTopic({ origin: ORIGIN, courseId: COURSE, topicId: 100 + i, path: path.join(dir, `f${i}.pdf`), size: i })));
    const state = await readSavedState(ORIGIN, COURSE);
    expect([...state.topics.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => 100 + i));
  });

  it("takes over a lock left by a process that died", async () => {
    await fs.writeFile(`${ledger}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: Date.now(), token: "dead" }));
    vi.resetModules();
    const { recordSavedTopic, useLedgerFile: use } = await import("../../src/sync/saved-topics.js");
    use(ledger);
    await recordSavedTopic({ origin: ORIGIN, courseId: COURSE, topicId: 5, path: path.join(dir, "a.pdf"), size: 1 });
    expect((await readSavedState(ORIGIN, COURSE)).topics.has(5)).toBe(true);
  });
});

describe("a folder that is not there is not a deleted file (review item 3)", () => {
  it("reports a remembered sync folder that is gone as unreadable state", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const root = path.join(dir, "course");
    await fs.mkdir(root);
    await tool(registerDownloadCourseFiles as never).call({ courseId: COURSE, downloadPath: root, ...syncArgs });
    await fs.rm(root, { recursive: true });
    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.complete).toBe(false);
    expect(result.stateUnreadable).toEqual([expect.objectContaining({ source: "syncFolder", where: expect.stringMatching(/course$/) })]);
  });

  it("refuses a syncFolder that does not exist", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const response = await unsaved().call({ courseId: COURSE, syncFolder: path.join(dir, "nope") });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/syncFolder/);
  });

  it("puts a saved file whose folder is gone in couldNotCheck, not savedFileMissing", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await saveOwnLayout(12, "usb/ECE", "HW12.pdf");
    await fs.rm(path.join(dir, "usb"), { recursive: true });
    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.savedFileMissing).toEqual([]);
    expect(result.couldNotCheck).toEqual([expect.objectContaining({ topicId: 12 })]);
    expect(result.complete).toBe(false);
  });
});

describe("keys from a file on disk cannot reach Object.prototype (review item 4)", () => {
  it("ignores __proto__ course, topic and sync-folder keys in the ledger", async () => {
    const entry = JSON.stringify({ path: path.join(dir, "x.pdf"), size: 1, savedAt: "2026-01-01T00:00:00Z" });
    // JSON.stringify would drop a literal __proto__ key, so the text is written raw.
    await fs.writeFile(ledger, `{"version":1,"schools":{"${ORIGIN}":{"courses":{"__proto__":{"7":${entry}},"${COURSE}":{"__proto__":${entry}}},"syncRoots":{"__proto__":[${JSON.stringify(dir)}]}}}}`);
    const state = await readSavedState(ORIGIN, COURSE);
    expect(state.unreadable).toEqual([]);
    expect(({} as any)[7]).toBeUndefined();
    expect(({} as any).path).toBeUndefined();
    expect(state.topics.size).toBe(0);
  });

  it("ignores __proto__ keys in a manifest", async () => {
    await fs.writeFile(path.join(dir, ".brightspace-sync.json"), '{"version":1,"courses":{"__proto__":{"7":{"path":"a.pdf","bytes":1}},"42":{"__proto__":{"path":"a.pdf","bytes":1}}}}');
    const manifest = await SyncManifest.load(dir);
    expect(({} as any)[7]).toBeUndefined();
    expect(({} as any).path).toBeUndefined();
    expect(manifest.entries(42)).toEqual([]);
  });
});

describe("a manifest of the wrong shape is unreadable, not empty (review item 5)", () => {
  it.each(["{}", "[]", "null", '{"courses":[]}', '{"courses":"x"}', '"text"'])("flags %s", async (text) => {
    await fs.writeFile(path.join(dir, ".brightspace-sync.json"), text);
    expect((await SyncManifest.load(dir)).unreadable).toBeTruthy();
  });

  it("does not flag an empty or missing one", async () => {
    expect((await SyncManifest.load(dir)).unreadable).toBeUndefined();
    await fs.writeFile(path.join(dir, ".brightspace-sync.json"), '{"version":1,"courses":{}}');
    expect((await SyncManifest.load(dir)).unreadable).toBeUndefined();
  });
});

describe("what the tool tells the agent (review items 7 and 8)", () => {
  it("says what unsaved means, and carries no always-zero unavailable count", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const { config, call } = unsaved();
    expect(config.description).toMatch(/no record of saving/i);
    expect(config.description).toMatch(/browser|manual copy/i);
    expect(config.description).toMatch(/not be open yet/i);
    const result = json(await call({ courseId: COURSE }));
    expect(result.unsavedNote).toMatch(/no record of saving/i);
    expect(result.unsavedNote).toMatch(/ask before downloading everything again/i);
    expect(config.description).toMatch(/Content area only, not the whole course/);
    expect(config.description).toMatch(/does not mean the whole course is saved/);
    expect(result.unsavedNote).toMatch(/Content area only/);
    expect(result.notCovered.map((n: any) => n.tool).join(" ")).toMatch(/get_assignments.*get_assignment_files.*get_announcement_files.*get_syllabus/);
    expect(result.nonFileCounts).not.toHaveProperty("unavailable");
    expect(result.nonFileCounts.link).toBe(1);
  });

  it("lists a file the sync skipped because it was already on disk, which no record claims", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const root = path.join(dir, "course");
    await fs.mkdir(path.join(root, "Homework"), { recursive: true });
    await fs.writeFile(path.join(root, "Homework", "HW11.pdf"), "mine");
    await tool(registerDownloadCourseFiles as never).call({ courseId: COURSE, downloadPath: root, ...syncArgs });
    const result = json(await unsaved().call({ courseId: COURSE }));
    expect(result.unsaved.map((t: any) => t.topicId)).toEqual([10]);
    expect(result.savedCount).toBe(1);
  });
});

describe("sync folders in the ledger (review item 10)", () => {
  it("records no folder for a dry run", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const root = path.join(dir, "course");
    await fs.mkdir(root);
    await tool(registerDownloadCourseFiles as never).call({ courseId: COURSE, downloadPath: root, dryRun: true, ...syncArgs });
    await expect(fs.stat(ledger)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the 20 most recent folders per course", async () => {
    for (let i = 0; i < 25; i++) await recordSyncRoot(ORIGIN, COURSE, path.join(dir, `r${i}`));
    const roots = JSON.parse(await fs.readFile(ledger, "utf8")).schools[ORIGIN].syncRoots[String(COURSE)];
    expect(roots).toHaveLength(20);
    expect(roots[0]).toBe(path.join(dir, "r5"));
    expect(roots[19]).toBe(path.join(dir, "r24"));
  });
});

/** A course-sync module whose ledger is this test's file (earlier tests reset the module registry). */
async function freshSync() {
  vi.resetModules();
  (await import("../../src/sync/saved-topics.js")).useLedgerFile(ledger);
  return import("../../src/sync/course-sync.js");
}

describe("recording a sync folder never delays the sync (release fix)", () => {
  it("downloads before a blocked ledger lock is released, and records the folder afterwards", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const slow = fake.client.getRaw.getMockImplementation()!;
    fake.client.getRaw.mockImplementation(async (p: string) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return slow(p);
    });
    // Another process holds the ledger lock (a live owner, so it is not taken over).
    await fs.writeFile(`${ledger}.lock`, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "other" }));
    setTimeout(() => void fs.rm(`${ledger}.lock`, { force: true }), 500);
    const root = path.join(dir, "course");
    await fs.mkdir(root);

    const { syncCourse } = await freshSync();
    const started = Date.now();
    const result = await syncCourse(fake.client as never, { courseId: COURSE, destination: root, deadlineMs: 200 });
    expect(result.downloaded.length).toBeGreaterThan(0);
    // The wait for the lock comes after the downloads, and is bounded.
    expect(Date.now() - started).toBeLessThan(3500);
    const roots = JSON.parse(await fs.readFile(ledger, "utf8")).schools[ORIGIN].syncRoots[String(COURSE)];
    expect(roots).toHaveLength(1);
  });

  it("does not remember a folder where nothing was saved", async () => {
    fake = await fakeBrightspace(toc, {});
    const root = path.join(dir, "empty");
    await fs.mkdir(root);
    const { syncCourse } = await freshSync();
    const result = await syncCourse(fake.client as never, { courseId: COURSE, destination: root, retryDelaysMs: [], sleep: async () => {} });
    expect(result.downloaded).toEqual([]);
    await expect(fs.stat(ledger)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("remembers the folder when a cancel stops the run", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const root = path.join(dir, "course");
    await fs.mkdir(root);
    const controller = new AbortController();
    const { syncCourse } = await freshSync();
    await syncCourse(fake.client as never, { courseId: COURSE, destination: root, signal: controller.signal, onProgress: (e) => { if (e.done === 1) controller.abort(); } });
    expect(JSON.parse(await fs.readFile(ledger, "utf8")).schools[ORIGIN].syncRoots[String(COURSE)]).toHaveLength(1);
  });
});

describe("recording a download_file save never holds up the answer", () => {
  it("answers promptly while the ledger lock is held, and records once it is free", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await fs.writeFile(`${ledger}.lock`, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "other" }));
    setTimeout(() => void fs.rm(`${ledger}.lock`, { force: true }), 2000);
    const target = path.join(dir, "out");
    await fs.mkdir(target);
    const started = Date.now();
    const response = await downloadFile().callRaw({ courseId: COURSE, topicId: 12, downloadPath: target });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(json(response).success).toBe(true);
    expect((await fs.readdir(target)).length).toBe(1);
    // The record still lands once the lock is free.
    for (let i = 0; i < 60 && !(await readSavedState(ORIGIN, COURSE)).topics.has(12); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await readSavedState(ORIGIN, COURSE)).topics.has(12)).toBe(true);
  });
});
