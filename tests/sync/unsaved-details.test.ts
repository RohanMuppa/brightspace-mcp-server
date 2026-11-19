import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { registerDownloadFile } from "../../src/tools/download-file.js";
import { registerDownloadCourseFiles } from "../../src/tools/download-course-files.js";
import { registerGetUnsavedCourseFiles } from "../../src/tools/get-unsaved-course-files.js";
import { useLedgerFile } from "../../src/sync/saved-topics.js";
import { fakeBrightspace, fileTopic, module_, pdf, tempRoot, type Fake } from "./harness.js";

const COURSE = 42;
let dir: string;
let fake: Fake;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await tempRoot();
  await fs.mkdir(path.join(dir, "state"));
  useLedgerFile(path.join(dir, "state", "saved-topics.json"));
});
afterEach(async () => {
  useLedgerFile();
  vi.restoreAllMocks();
  await fake?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function tool(register: (server: never, client: never) => void) {
  let handler: any;
  register({ registerTool: (_n: string, _c: unknown, f: any) => { handler = f; } } as never, fake.client as never);
  return (args: Record<string, unknown>) => handler(args);
}
const json = (response: any) => JSON.parse(response.content[0].text);

describe("every topic in the table of contents lands in exactly one counter", () => {
  // The shapes a course can hold: files, links (including quiz quickLinks), embedded media, broken items, other tools.
  const quiz = (id: number) => ({ TopicId: id, Title: `Quiz ${id}`, TypeIdentifier: "Link", TopicType: 3, Url: "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=42&type=quiz&rcode=x" });
  const toc = {
    Modules: [
      module_(1, "Homeworks", [fileTopic(10, "/content/enforced/42-C/a.pdf"), quiz(20), quiz(21), quiz(22)], [
        module_(2, "Nested", [fileTopic(11, "/content/enforced/42-C/b.pdf"), { TopicId: 30, Title: "Video", TypeIdentifier: "ContentService" }, { TopicId: 31, Title: "Broken", TypeIdentifier: "File", TopicType: 1, IsBroken: true }, { TopicId: 32, Title: "Discussion", TypeIdentifier: "Discussion", TopicType: 5 }]),
      ]),
    ],
  };

  it("reports a total the agent can check against the counters, and a per-type breakdown", async () => {
    fake = await fakeBrightspace(toc, {});
    const result = json(await tool(registerGetUnsavedCourseFiles as never)({ courseId: COURSE }));
    const counted = result.fileTopicCount + Object.values(result.nonFileCounts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(result.tableOfContents.topics).toBe(8);
    expect(counted).toBe(8);
    expect(result.tableOfContents.modules).toBe(2);
    expect(result.nonFileCounts).toMatchObject({ link: 3, media: 1, broken: 1, other: 1 });
    expect(result.tableOfContents.topicTypes).toMatchObject({ "Link/3": 3, "File/1": 3, "ContentService/?": 1, "Discussion/5": 1 });
    expect(result.tableOfContents.unreadEntries).toBe(0);
    expect(result.tableOfContents.note).toMatch(/does not include them/i);
  });

  it("counts an entry it could not read, and says the answer is incomplete", async () => {
    const odd = { Modules: [module_(1, "M", [fileTopic(10, "/content/enforced/42-C/a.pdf"), "stray", null, 7])] };
    fake = await fakeBrightspace(odd, {});
    const result = json(await tool(registerGetUnsavedCourseFiles as never)({ courseId: COURSE }));
    expect(result.tableOfContents.unreadEntries).toBe(3);
    expect(result.complete).toBe(false);
    expect(result.notice).toMatch(/could not be read as topics/i);
  });

  it("puts the same total in the download_course_files summary", async () => {
    fake = await fakeBrightspace(toc, { 10: { body: pdf("a") }, 11: { body: pdf("b") } });
    const root = path.join(dir, "course");
    await fs.mkdir(root);
    const response = await tool(registerDownloadCourseFiles as never)({ courseId: COURSE, downloadPath: root, existing: "skip", maxFiles: 300, maxMinutes: 8, maxTotalMB: 100 });
    expect(response.content[0].text).toMatch(/table of contents lists 8 topics: 2 files and 6 that are not files/);
  });
});

describe("entries carry the topic title and lastModified", () => {
  const toc = {
    Modules: [module_(1, "Homework", [
      fileTopic(10, "/content/enforced/42-C/a.pdf", { Title: "ECE2k2_HW11", LastModifiedDate: "2026-02-01T10:00:00.000Z" }),
      fileTopic(12, "/content/enforced/42-C/b.pdf", { Title: "ECE2k2_HW12" }),
    ])],
  };

  it("adds title and lastModified (when the table has it) to unsaved entries", async () => {
    fake = await fakeBrightspace(toc, {});
    const result = json(await tool(registerGetUnsavedCourseFiles as never)({ courseId: COURSE }));
    expect(result.unsaved[0]).toMatchObject({ topicId: 10, title: "ECE2k2_HW11", lastModified: "2026-02-01T10:00:00.000Z" });
    expect(result.unsaved[1]).toMatchObject({ topicId: 12, title: "ECE2k2_HW12" });
    expect(result.unsaved[1]).not.toHaveProperty("lastModified");
  });

  it("adds them to savedFileMissing and couldNotCheck entries", async () => {
    fake = await fakeBrightspace(toc, { 10: { body: pdf("a") }, 12: { body: pdf("b") } });
    const save = async (topicId: number, folder: string) => {
      const target = path.join(dir, folder);
      await fs.mkdir(target, { recursive: true });
      return json(await tool(registerDownloadFile as never)({ courseId: COURSE, topicId, downloadPath: target })).filePath as string;
    };
    const first = await save(10, "kept");
    await save(12, "usb/gone");
    await fs.rm(first);
    await fs.rm(path.join(dir, "usb"), { recursive: true });
    const result = json(await tool(registerGetUnsavedCourseFiles as never)({ courseId: COURSE }));
    expect(result.savedFileMissing[0]).toMatchObject({ topicId: 10, title: "ECE2k2_HW11", lastModified: "2026-02-01T10:00:00.000Z" });
    expect(result.couldNotCheck[0]).toMatchObject({ topicId: 12, title: "ECE2k2_HW12" });
  });
});
