import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { registerDownloadFile } from "../../src/tools/download-file.js";
import { registerGetUnsavedCourseFiles } from "../../src/tools/get-unsaved-course-files.js";
import { registerMarkCourseFilesSaved } from "../../src/tools/mark-course-files-saved.js";
import { readSavedState, useLedgerFile, useLedgerLockWait } from "../../src/sync/saved-topics.js";
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
  useLedgerLockWait();
  vi.restoreAllMocks();
  await fake?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const toc = {
  Modules: [
    module_(1, "Homework", [
      fileTopic(10, "/content/enforced/42-C/HW11.pdf"),
      fileTopic(12, "/content/enforced/42-C/HW12.pdf"),
      fileTopic(14, "/content/enforced/42-C/HW13.pdf"),
      { TopicId: 13, TypeIdentifier: "Link", TopicType: 3, Title: "A link" },
    ]),
  ],
};
const bodies = { 10: { body: pdf("a") }, 12: { body: pdf("b") }, 14: { body: pdf("c") } };

function tool(register: (server: never, client: never) => void) {
  let config: any;
  let handler: any;
  register({ registerTool: (_n: string, c: unknown, f: any) => { config = c; handler = f; } } as never, fake.client as never);
  return { config, call: (args: Record<string, unknown>) => handler(args) };
}
const mark = () => tool(registerMarkCourseFilesSaved as never);
const unsaved = () => tool(registerGetUnsavedCourseFiles as never);
const json = (response: any) => JSON.parse(response.content[0].text);
const unsavedIds = async () => json(await unsaved().call({ courseId: COURSE })).unsaved.map((t: any) => t.topicId);

async function ownFile(name: string): Promise<string> {
  const file = path.join(dir, "mine", name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, pdf(name));
  return file;
}

describe("mark_course_files_saved: marking", () => {
  it("marks topics saved without a path, and the diff shows them distinctly", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const result = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 10 }, { topicId: 12 }] }));
    expect(result.marked.map((m: any) => m.topicId)).toEqual([10, 12]);
    expect(result.refused).toEqual([]);

    const diff = json(await unsaved().call({ courseId: COURSE }));
    expect(diff.unsaved.map((t: any) => t.topicId)).toEqual([14]);
    expect(diff.savedCount).toBe(2);
    expect(diff.markedSavedCount).toBe(2);
    expect(diff.complete).toBe(true);
    expect(diff.notice).toMatch(/marked saved.*never checked a file/i);
  });

  it("keeps the ledger at version 1, so an older server still reads it", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await mark().call({ courseId: COURSE, topics: [{ topicId: 10 }, { topicId: 12, path: await ownFile("hw12.pdf") }] });
    const file = JSON.parse(await fs.readFile(ledger, "utf8"));
    expect(file.version).toBe(1);
    // A marked topic with a path is an ordinary entry to an older reader: absolute path, size, savedAt.
    expect(file.schools[ORIGIN].courses[String(COURSE)]["12"]).toMatchObject({ path: expect.any(String), size: expect.any(Number), savedAt: expect.any(String) });
  });

  it("marks with a path that exists: verified, not counted as marked-only, and flagged when it later goes", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const file = await ownFile("HW12 - Problems.pdf");
    const result = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 12, path: file }] }));
    expect(result.marked).toEqual([expect.objectContaining({ topicId: 12, path: file })]);
    expect((await readSavedState(ORIGIN, COURSE)).topics.get(12)![0].path).toBe(file);
    const diff = json(await unsaved().call({ courseId: COURSE }));
    expect(diff.markedSavedCount).toBe(0);
    expect(diff.savedCount).toBe(1);

    await fs.rm(file);
    expect(json(await unsaved().call({ courseId: COURSE })).savedFileMissing.map((t: any) => t.topicId)).toEqual([12]);
  });

  it("refuses a relative, missing or non-file path per item, and still marks the rest", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await fs.mkdir(path.join(dir, "folder"));
    const result = json(await mark().call({
      courseId: COURSE,
      topics: [
        { topicId: 10, path: "relative/HW11.pdf" },
        { topicId: 12, path: path.join(dir, "nope.pdf") },
        { topicId: 14, path: path.join(dir, "folder") },
        { topicId: 13 },
      ],
    }));
    expect(result.marked).toEqual([]);
    expect(result.refused.map((r: any) => r.topicId)).toEqual([10, 12, 14, 13]);
    expect(result.refused[0].reason).toMatch(/absolute/i);
    expect(result.refused[1].reason).toMatch(/does not exist/i);
    expect(result.refused[2].reason).toMatch(/not a file/i);
    expect(await unsavedIds()).toEqual([10, 12, 14]);

    const mixed = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 10, path: "x" }, { topicId: 12 }] }));
    expect(mixed.marked.map((m: any) => m.topicId)).toEqual([12]);
    expect(mixed.refused.map((r: any) => r.topicId)).toEqual([10]);
  });

  it("refuses ids that are not file topics of this course, with a reason", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const result = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 13 }, { topicId: 999 }, { topicId: 10 }] }));
    expect(result.marked.map((m: any) => m.topicId)).toEqual([10]);
    expect(result.refused).toEqual([
      expect.objectContaining({ topicId: 13, reason: expect.stringMatching(/not a file topic/i) }),
      expect.objectContaining({ topicId: 999, reason: expect.stringMatching(/not in this course/i) }),
    ]);
  });

  it("does not downgrade a verified record to a bare mark", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const target = path.join(dir, "out");
    await fs.mkdir(target);
    await tool(registerDownloadFile as never).call({ courseId: COURSE, topicId: 12, downloadPath: target });
    const result = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 12 }] }));
    expect(result.alreadyRecorded.map((r: any) => r.topicId)).toEqual([12]);
    expect((await readSavedState(ORIGIN, COURSE)).topics.get(12)![0].path).toBeTruthy();
  });
});

describe("mark_course_files_saved: everything currently unsaved", () => {
  it("marks every unsaved topic only when asked outright, and leaves recorded ones alone", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await mark().call({ courseId: COURSE, topics: [{ topicId: 10, path: await ownFile("a.pdf") }] });
    const result = json(await mark().call({ courseId: COURSE, allUnsaved: true }));
    expect(result.marked.map((m: any) => m.topicId)).toEqual([12, 14]);
    expect(await unsavedIds()).toEqual([]);
    expect((await readSavedState(ORIGIN, COURSE)).topics.get(10)![0].path).toBeTruthy();
  });

  it("is never the default: a call that names nothing is an error and writes nothing", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const response = await mark().call({ courseId: COURSE });
    expect(response.isError).toBe(true);
    expect(await unsavedIds()).toEqual([10, 12, 14]);
    const both = await mark().call({ courseId: COURSE, allUnsaved: true, topics: [{ topicId: 10 }] });
    expect(both.isError).toBe(true);
    expect(await unsavedIds()).toEqual([10, 12, 14]);
  });

  it("refuses when the saved records could not be read, since 'unsaved' is then unknown", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const future = JSON.stringify({ version: 2, schools: {} });
    await fs.writeFile(ledger, future);
    const response = await mark().call({ courseId: COURSE, allUnsaved: true });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/could not be read/i);
    expect(await fs.readFile(ledger, "utf8")).toBe(future);
  });
});

describe("mark_course_files_saved: undo", () => {
  it("unmarks topics, forgetting the record and never touching a file", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const file = await ownFile("hw12.pdf");
    await mark().call({ courseId: COURSE, topics: [{ topicId: 10 }, { topicId: 12, path: file }] });
    const result = json(await mark().call({ courseId: COURSE, unmarkTopicIds: [10, 12, 14] }));
    expect(result.unmarked).toEqual([10, 12]);
    expect(result.notRecorded).toEqual([14]);
    expect(await unsavedIds()).toEqual([10, 12, 14]);
    expect((await fs.stat(file)).isFile()).toBe(true);
  });
});

describe("mark_course_files_saved: the record is the point", () => {
  it("says the marking failed when the ledger cannot be written", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await fs.writeFile(path.join(dir, "blocker"), "x");
    useLedgerFile(path.join(dir, "blocker", "saved-topics.json"));
    const response = await mark().call({ courseId: COURSE, topics: [{ topicId: 10 }] });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/marking failed/i);
    expect(response.content[0].text).toMatch(/nothing was (marked|recorded)/i);
  });

  it("says the marking failed when another process holds the ledger lock", async () => {
    fake = await fakeBrightspace(toc, bodies);
    useLedgerLockWait(100);
    await fs.writeFile(`${ledger}.lock`, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "other" }));
    const response = await mark().call({ courseId: COURSE, topics: [{ topicId: 10 }] });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/marking failed/i);
    expect(response.content[0].text).toMatch(/locked/i);
    await fs.rm(`${ledger}.lock`);
    expect(await unsavedIds()).toEqual([10, 12, 14]);
  });
});

describe("how the tools describe themselves", () => {
  it("is not read-only, writes only the ledger, and tells the agent to ask first", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const { config } = mark();
    expect(config.annotations.readOnlyHint).toBe(false);
    expect(config.annotations.destructiveHint).toBe(false);
    expect(config.description).toMatch(/writes only the server's own record/i);
    expect(config.description).toMatch(/ask the student before marking everything/i);
    expect(config.description).toMatch(/never mark files as saved to make a list shorter/i);
  });

  it("points get_unsaved_course_files at it for files the student already has", async () => {
    fake = await fakeBrightspace(toc, bodies);
    expect(unsaved().config.description).toContain("mark_course_files_saved");
    expect(json(await unsaved().call({ courseId: COURSE })).unsavedNote).toContain("mark_course_files_saved");
  });
});
