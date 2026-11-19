import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { registerDownloadFile } from "../../src/tools/download-file.js";
import { registerDownloadCourseFiles } from "../../src/tools/download-course-files.js";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";
import { registerGetUnsavedCourseFiles } from "../../src/tools/get-unsaved-course-files.js";
import { FIND_NEW_FILES_GUIDANCE } from "../../src/tools/tool-helpers.js";
import { readSavedState, useLedgerFile } from "../../src/sync/saved-topics.js";
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

/** Registers a tool and hands back its config and handler. */
function tool(register: (server: never, client: never) => void) {
  let config: any;
  let handler: any;
  register({ registerTool: (_n: string, c: unknown, f: any) => { config = c; handler = f; } } as never, fake.client as never);
  return { config, call: (args: Record<string, unknown>, extra?: unknown) => handler(args, extra) };
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
