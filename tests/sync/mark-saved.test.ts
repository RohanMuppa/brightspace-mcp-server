import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { registerDownloadFile, settleSavedTopicRecords } from "../../src/tools/download-file.js";
import { registerGetUnsavedCourseFiles } from "../../src/tools/get-unsaved-course-files.js";
import { registerMarkCourseFilesSaved } from "../../src/tools/mark-course-files-saved.js";
import { readSavedState, useLedgerFile } from "../../src/sync/saved-topics.js";
import { isNetworkOrDevicePath } from "../../src/utils/sensitive-paths.js";
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
      fileTopic(14, "/content/enforced/42-C/HW13.pdf"),
      { TopicId: 13, TypeIdentifier: "Link", TopicType: 3, Title: "A link" },
    ]),
  ],
};
const bodies = { 10: { body: pdf("a") }, 12: { body: pdf("b") }, 14: { body: pdf("c") } };

/** Runs a tool, then waits for any ledger write the answer stopped waiting for, so the next read sees it. */
const settled = async (response: Promise<unknown>): Promise<any> => {
  const value = await response;
  await settleSavedTopicRecords();
  return value;
};
function tool(register: (server: never, client: never, options?: never) => void, options?: unknown) {
  let config: any;
  let handler: any;
  register({ registerTool: (_n: string, c: unknown, f: any) => { config = c; handler = f; } } as never, fake.client as never, options as never);
  return { config, call: (args: Record<string, unknown>) => settled(handler(args)) };
}
const mark = (options?: { lockWaitMs?: number }) => tool(registerMarkCourseFilesSaved as never, options);
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

  it("marks with a path that exists, checks it, and flags it when it later goes", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const file = await ownFile("HW12 - Problems.pdf");
    const result = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 12, path: file }] }));
    expect(result.marked).toEqual([expect.objectContaining({ topicId: 12, path: file })]);
    expect((await readSavedState(ORIGIN, COURSE)).topics.get(12)![0].path).toBe(file);
    const diff = json(await unsaved().call({ courseId: COURSE }));
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
    await fs.writeFile(`${ledger}.lock`, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "other" }));
    const response = await mark({ lockWaitMs: 100 }).call({ courseId: COURSE, topics: [{ topicId: 10 }] });
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

describe("network and device paths are never accepted (review 1)", () => {
  const bad = ["\\\\attacker\\share\\x.pdf", "//attacker/share/x.pdf", "\\\\?\\C:\\x.pdf", "\\\\.\\pipe\\x", "//?/C:/x.pdf"];

  it.each(bad)("recognises %s as a network or device path, and lets drive letters and ordinary paths through", (value) => {
    expect(isNetworkOrDevicePath(value)).toBe(true);
    for (const fine of ["Z:\\share\\x.pdf", "C:/Users/me/x.pdf", "/home/me/x.pdf", "relative/x.pdf", "D:\\"]) expect(isNetworkOrDevicePath(fine)).toBe(false);
  });

  it("refuses such a mark path per item with a reason, and marks the rest", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const result = json(await mark().call({ courseId: COURSE, topics: [...bad.map((p) => ({ topicId: 10, path: p })), { topicId: 12 }] }));
    expect(result.marked.map((m: any) => m.topicId)).toEqual([12]);
    expect(result.refused).toHaveLength(1); // the same topic id is judged once
    expect(result.refused[0].reason).toMatch(/network or device path/i);
    for (const p of bad.slice(1)) {
      const again = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 14, path: p }] }));
      expect(again.refused[0].reason).toMatch(/network or device path/i);
    }
  });

  it("drops a ledger entry and a remembered sync folder that name such a path", async () => {
    const entry = (p: string) => ({ path: p, size: 1, savedAt: "2026-01-01T00:00:00Z" });
    await fs.writeFile(ledger, JSON.stringify({ version: 1, schools: { [ORIGIN]: { courses: { [COURSE]: { 10: entry("//attacker/share/x.pdf"), 12: entry("\\\\attacker\\share\\y.pdf") } }, syncRoots: { [COURSE]: ["//attacker/share", "\\\\?\\C:\\x"] } } } }));
    const state = await readSavedState(ORIGIN, COURSE);
    expect(state.topics.size).toBe(0);
    expect(state.unreadable).toEqual([]);
  });

  it("refuses such a syncFolder argument before touching it", async () => {
    fake = await fakeBrightspace(toc, bodies);
    for (const p of bad) {
      const response = await unsaved().call({ courseId: COURSE, syncFolder: p });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/network or device path|absolute/i);
    }
    const posixUnc = await unsaved().call({ courseId: COURSE, syncFolder: "//attacker/share" });
    expect(posixUnc.content[0].text).toMatch(/network or device path/i);
  });
});

describe("marked entries are always shown as marked (review 2)", () => {
  it("counts a mark with a path as marked, still checks its file, and lists the marked ids", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const file = await ownFile("hw12.pdf");
    await mark().call({ courseId: COURSE, topics: [{ topicId: 10 }, { topicId: 12, path: file }] });
    const diff = json(await unsaved().call({ courseId: COURSE }));
    expect(diff.markedSavedCount).toBe(2);
    expect(diff.markedTopicIds).toEqual([10, 12]);
    await fs.rm(file);
    const gone = json(await unsaved().call({ courseId: COURSE }));
    expect(gone.savedFileMissing.map((t: any) => t.topicId)).toEqual([12]);
    expect(gone.markedSavedCount).toBe(1);
    expect(gone.markedTopicIds).toEqual([10]);
  });

  it("bounds the list of marked ids", async () => {
    const many = { Modules: [module_(1, "M", Array.from({ length: 600 }, (_, i) => fileTopic(1000 + i, `/content/enforced/42-C/f${i}.pdf`)))] };
    fake = await fakeBrightspace(many, {});
    await mark().call({ courseId: COURSE, allUnsaved: true });
    const diff = json(await unsaved().call({ courseId: COURSE }));
    expect(diff.markedSavedCount).toBe(600);
    expect(diff.markedTopicIds).toHaveLength(500);
    expect(diff.markedTopicIdsTruncated).toBe(true);
  });
});

describe("a pathed mark keeps a real download record (review 3)", () => {
  it("reports alreadyRecorded with the download's path while that file is there", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const target = path.join(dir, "out");
    await fs.mkdir(target);
    const saved = json(await tool(registerDownloadFile as never).call({ courseId: COURSE, topicId: 12, downloadPath: target })).filePath;
    const result = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 12, path: await ownFile("hw12.pdf") }] }));
    expect(result.marked).toEqual([]);
    expect(result.alreadyRecorded).toEqual([expect.objectContaining({ topicId: 12, path: saved })]);
    expect((await readSavedState(ORIGIN, COURSE)).topics.get(12)![0].path).toBe(saved);
  });

  it("replaces it when its file is gone, and never drops a known lastModified", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const missing = path.join(dir, "gone", "hw12.pdf");
    await fs.writeFile(ledger, JSON.stringify({ version: 1, schools: { [ORIGIN]: { courses: { [COURSE]: { 12: { path: missing, size: 1, savedAt: "2026-01-01T00:00:00Z", lastModified: "2026-01-01T00:00:00.000Z" } } }, syncRoots: {} } } }));
    const mine = await ownFile("hw12.pdf");
    const result = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 12, path: mine }] }));
    expect(result.marked.map((m: any) => m.topicId)).toEqual([12]);
    const entry = JSON.parse(await fs.readFile(ledger, "utf8")).schools[ORIGIN].courses[String(COURSE)]["12"];
    expect(entry.path).toBe(mine);
    expect(entry.marked).toBe(true);
    expect(entry.lastModified).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("marking against a table that was cut off or partly unread (review 4)", () => {
  it("does not call a file topic past the cut-off 'not a file topic', and says the table was cut off", async () => {
    let deep: any = module_(99, "deep", [fileTopic(10, "/content/enforced/42-C/a.pdf")]);
    for (let i = 0; i < 40; i++) deep = module_(i, `m${i}`, [], [deep]);
    fake = await fakeBrightspace({ Modules: [deep, module_(5, "Top", [fileTopic(12, "/content/enforced/42-C/b.pdf")])] }, bodies);
    const result = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 10 }, { topicId: 12 }] }));
    expect(result.marked.map((m: any) => m.topicId)).toEqual([12]);
    expect(result.refused[0].reason).not.toMatch(/not a file topic/i);
    expect(result.refused[0].reason).toMatch(/cut off/i);
    expect(result.tocTruncated).toBe(true);
    expect(result.notice).toMatch(/cut off/i);
  });

  it("says unreadable entries may hide the topic", async () => {
    fake = await fakeBrightspace({ Modules: [module_(1, "M", [fileTopic(12, "/content/enforced/42-C/b.pdf"), "stray"])] }, bodies);
    const result = json(await mark().call({ courseId: COURSE, topics: [{ topicId: 10 }] }));
    expect(result.refused[0].reason).toMatch(/could not be read/i);
    expect(result.notice).toMatch(/could not be read/i);
  });

  it("refuses allUnsaved when the table was cut off, and when it had unreadable entries", async () => {
    let deep: any = module_(99, "deep", [fileTopic(10, "/content/enforced/42-C/a.pdf")]);
    for (let i = 0; i < 40; i++) deep = module_(i, `m${i}`, [], [deep]);
    fake = await fakeBrightspace({ Modules: [deep] }, bodies);
    const cut = await mark().call({ courseId: COURSE, allUnsaved: true });
    expect(cut.isError).toBe(true);
    expect(cut.content[0].text).toMatch(/cut off/i);
    await fake.close();
    fake = await fakeBrightspace({ Modules: [module_(1, "M", [fileTopic(12, "/content/enforced/42-C/b.pdf"), "stray"])] }, bodies);
    const unread = await mark().call({ courseId: COURSE, allUnsaved: true });
    expect(unread.isError).toBe(true);
    expect(unread.content[0].text).toMatch(/could not be read/i);
    await expect(fs.stat(ledger)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("a write that would change nothing does not happen (review 7)", () => {
  it("returns the refusals, not 'Marking failed', when every item is refused and the ledger is unwritable", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await fs.writeFile(path.join(dir, "blocker"), "x");
    useLedgerFile(path.join(dir, "blocker", "saved-topics.json"));
    const response = await mark().call({ courseId: COURSE, topics: [{ topicId: 13 }, { topicId: 999 }] });
    expect(response.isError).toBeUndefined();
    expect(json(response).refused.map((r: any) => r.topicId)).toEqual([13, 999]);
  });

  it("never moves a damaged ledger aside for a no-op", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await fs.writeFile(ledger, "{ not json");
    await mark().call({ courseId: COURSE, topics: [{ topicId: 13 }] });
    const unmarked = await mark().call({ courseId: COURSE, unmarkTopicIds: [10] });
    expect(unmarked.isError).toBe(true);
    expect(await fs.readFile(ledger, "utf8")).toBe("{ not json");
    expect((await fs.readdir(path.dirname(ledger))).filter((n) => n.includes(".corrupt-") || n.endsWith(".lock"))).toEqual([]);
  });

  it("does not rewrite the ledger when unmark finds nothing recorded", async () => {
    fake = await fakeBrightspace(toc, bodies);
    await mark().call({ courseId: COURSE, topics: [{ topicId: 10 }] });
    const before = await fs.stat(ledger);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = json(await mark().call({ courseId: COURSE, unmarkTopicIds: [14] }));
    expect(result.notRecorded).toEqual([14]);
    expect((await fs.stat(ledger)).mtimeMs).toBe(before.mtimeMs);
  });
});

describe("unmark says what kind of record it removed (review 8)", () => {
  it("tells a mark from a download's record, per item", async () => {
    fake = await fakeBrightspace(toc, bodies);
    const target = path.join(dir, "out");
    await fs.mkdir(target);
    const saved = json(await tool(registerDownloadFile as never).call({ courseId: COURSE, topicId: 12, downloadPath: target })).filePath;
    await mark().call({ courseId: COURSE, topics: [{ topicId: 10 }] });
    const result = json(await mark().call({ courseId: COURSE, unmarkTopicIds: [10, 12] }));
    expect(result.unmarkedRecords).toEqual([
      { topicId: 10, was: "mark" },
      { topicId: 12, was: "download", path: saved },
    ]);
    expect(result.unmarked).toEqual([10, 12]);
  });
});
