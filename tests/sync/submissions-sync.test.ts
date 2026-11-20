import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { syncCourse, type SyncOptions, type SyncResult } from "../../src/sync/course-sync.js";
import { SyncManifest } from "../../src/sync/manifest.js";
import { fileTopic, listTree, module_, pdf, tempRoot, type Fake, type Step } from "./harness.js";
import { fakeCourse, folder, route, status, submission, type Extras } from "./extras-harness.js";

let parent: string;
let root: string;
let fake: (Fake & { rawRequests: string[] }) | undefined;

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

const ok = (tag = "x"): Step => ({ body: pdf(tag) });
const url = (name: string) => `/content/enforced/42-Course/${encodeURIComponent(name)}`;
const FOLDERS = route("/dropbox/folders/");
const subsRoute = (id: number) => route(`/dropbox/folders/${id}/submissions/mysubmissions/`);
const fbRoute = (id: number) => route(`/dropbox/folders/${id}/feedback/myFeedback/`);
const subFile = (folderId: number, subId: number, fileId: number) => route(`/dropbox/folders/${folderId}/submissions/${subId}/files/${fileId}`);
const attFile = (folderId: number, fileId: number) => route(`/dropbox/folders/${folderId}/attachments/${fileId}`);

const EMPTY_TOC = { Modules: [], Topics: [] };

interface Setup {
  toc?: unknown;
  topics?: Record<number, Step | Step[]>;
  routes?: Record<string, unknown>;
  files?: Record<string, Step | Step[]>;
}

const extras: Extras = { routes: {}, files: {} };
const resetExtras = (setup: Setup) => {
  extras.routes = { ...(setup.routes ?? {}) };
  extras.files = { ...(setup.files ?? {}) };
};

async function run(setup: Setup, options: Partial<SyncOptions> = {}): Promise<SyncResult> {
  resetExtras(setup);
  fake = await fakeCourse(setup.toc ?? EMPTY_TOC, setup.topics ?? {}, extras);
  return syncCourse(fake.client, {
    courseId: 42,
    destination: root,
    sleep: async () => {},
    retryDelaysMs: [],
    includeSubmissions: true,
    ...options,
  });
}

/** Run again against the same fake, with the route tables edited by `change`. */
async function again(change: (e: Extras) => void, options: Partial<SyncOptions> = {}): Promise<SyncResult> {
  change(extras);
  return syncCourse(fake!.client, { courseId: 42, destination: root, sleep: async () => {}, retryDelaysMs: [], includeSubmissions: true, ...options });
}

const read = (rel: string) => fs.readFile(path.join(root, ...rel.split("/")), "utf8");

/** One assignment with a submission, an instructor attachment and graded feedback with a feedback file. */
const essay = (): Setup => ({
  routes: {
    [FOLDERS]: [folder(5, "Essay 2", { Attachments: [{ FileId: 21, FileName: "Prompt.pdf", Size: 10 }] })],
    [subsRoute(5)]: [submission(3, [{ FileId: 11, FileName: "Essay.docx" }])],
    [fbRoute(5)]: { IsGraded: true, Score: 18, Feedback: { Text: "Good thesis.", Html: "" }, Files: [{ FileId: 31, FileName: "Marked-up.pdf", Size: 10 }] },
    "/d2l/api/lp/1.99/users/whoami": { Identifier: 77 },
  },
  files: {
    [subFile(5, 3, 11)]: ok("sub"),
    [attFile(5, 21)]: ok("prompt"),
    [route("/dropbox/folders/5/feedback/user/77/attachments/31")]: ok("fb"),
  },
});

describe("full course pull: assignments", () => {
  it("saves submissions, feedback.md, feedback files and assignment files in the documented layout", async () => {
    const result = await run(essay(), { includeAssignmentFiles: true });
    expect(await listTree(root)).toEqual([
      "Assignments/",
      "Assignments/Essay 2/",
      "Assignments/Essay 2/assignment files/",
      "Assignments/Essay 2/assignment files/Prompt.pdf",
      "Assignments/Essay 2/feedback files/",
      "Assignments/Essay 2/feedback files/Marked-up.pdf",
      "Assignments/Essay 2/feedback.md",
      "Assignments/Essay 2/my files/",
      "Assignments/Essay 2/my files/Essay.docx",
    ]);
    expect(result.assignments).toMatchObject({
      folders: 1, submissionFilesDownloaded: 1, assignmentFilesDownloaded: 1, feedbackFilesDownloaded: 1,
      feedbackWritten: 1, notSubmitted: 0, unknown: [],
    });
    expect(result.failed).toEqual([]);
    expect(result.downloaded.map((f) => f.path)).toContain("Assignments/Essay 2/feedback.md");
    const md = await read("Assignments/Essay 2/feedback.md");
    expect(md).toContain('# "Essay 2" (assignment 5)');
    expect(md).toContain("- Score: 18 / 20");
    expect(md).toContain('- Files: "my files/Essay.docx"');
    expect(md).toContain("> Good thesis.");
    expect(md).toContain('- "feedback files/Marked-up.pdf"');
    const record = (await SyncManifest.load(root)).findAssignment(42, 5)!;
    expect(record.dir).toBe("Assignments/Essay 2");
    expect(Object.keys(record.files).sort()).toEqual(["asg:21", "fb:31", "sub:3:11"]);
    expect(record.feedback?.path).toBe("Assignments/Essay 2/feedback.md");
  });

  it("with includeAssignmentFiles alone saves only the instructor's files and reads no submissions or feedback", async () => {
    const result = await run(essay(), { includeSubmissions: false, includeAssignmentFiles: true });
    expect(await listTree(root)).toEqual(["Assignments/", "Assignments/Essay 2/", "Assignments/Essay 2/assignment files/", "Assignments/Essay 2/assignment files/Prompt.pdf"]);
    expect(result.assignments?.assignmentFilesDownloaded).toBe(1);
    const paths = fake!.client.get.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(paths.some((p) => p.includes("mysubmissions") || p.includes("feedback"))).toBe(false);
  });

  it("with every option off, touches no extra route and leaves the result without extra blocks", async () => {
    const result = await run(essay(), { includeSubmissions: false });
    expect(result.assignments).toBeUndefined();
    expect(result.announcements).toBeUndefined();
    expect(await listTree(root)).toEqual([]);
    const paths = fake!.client.get.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(paths.some((p) => p.includes("/dropbox/") || p.includes("/news/"))).toBe(false);
    expect(fake!.rawRequests).toEqual([]);
  });

  it("renames a Content module called Assignments instead of colliding, only when the option is on", async () => {
    const toc = { Modules: [module_(1, "Assignments", [fileTopic(10, url("Intro.pdf"))])], Topics: [] };
    await run({ ...essay(), toc, topics: { 10: ok("c") } });
    const tree = await listTree(root);
    expect(tree).toContain("Assignments (2)/Intro.pdf");
    expect(tree).toContain("Assignments/Essay 2/feedback.md");
    await fs.rm(root, { recursive: true });
    await fs.mkdir(root);
    await fake?.close();
    await run({ ...essay(), toc, topics: { 10: ok("c") } }, { includeSubmissions: false });
    expect(await listTree(root)).toEqual(["Assignments/", "Assignments/Intro.pdf"]);
  });

  it("makes hostile names safe and unique", async () => {
    const long = "L".repeat(300);
    const setup: Setup = {
      routes: {
        [FOLDERS]: [folder(1, "../x"), folder(2, "CON"), folder(3, "\\\\host\\share"), folder(4, long), folder(5, "Same"), folder(6, "same"), folder(7, "Same")],
        "/d2l/api/lp/1.99/users/whoami": { Identifier: 77 },
      },
      files: {},
    };
    for (let id = 1; id <= 7; id++) setup.routes![subsRoute(id)] = status(404);
    await run(setup);
    const dirs = (await listTree(root)).filter((entry) => entry.split("/").length === 3 && entry.endsWith("/"));
    const names = dirs.map((d) => d.split("/")[1]);
    expect(names).toHaveLength(7);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(7);
    for (const name of names) {
      expect(name).not.toMatch(/[\\/:]/);
      expect(name.startsWith(".")).toBe(false);
      expect(Array.from(name).length).toBeLessThanOrEqual(150);
    }
    expect(names).toContain("Same");
    expect(names).toContain("same (2)");
    expect(names).toContain("Same (3)");
    expect(names.some((n) => n.toUpperCase() === "CON")).toBe(false);
    // Nothing escaped the destination.
    expect(await fs.readdir(parent)).toEqual(["dest"]);
  });

  it("numbers a resubmission with the same file name", async () => {
    const setup = essay();
    setup.routes![subsRoute(5)] = [
      submission(3, [{ FileId: 11, FileName: "Essay.docx" }], "A. Student", "2026-10-01T00:00:00Z"),
      submission(4, [{ FileId: 12, FileName: "Essay.docx" }], "A. Student", "2026-10-02T00:00:00Z"),
    ];
    setup.files![subFile(5, 4, 12)] = ok("second");
    await run(setup);
    const tree = await listTree(root);
    expect(tree).toContain("Assignments/Essay 2/my files/Essay.docx");
    expect(tree).toContain("Assignments/Essay 2/my files/Essay (2).docx");
  });

  it("reads EntityDropbox submissions and their embedded feedback", async () => {
    const setup = essay();
    delete setup.routes![fbRoute(5)];
    setup.routes![subsRoute(5)] = [{ Entity: {}, Feedback: { IsGraded: true, Score: 7, Feedback: { Text: "Embedded", Html: "" } }, Submissions: [submission(3, [{ FileId: 11, FileName: "Essay.docx" }])] }];
    await run(setup);
    const md = await read("Assignments/Essay 2/feedback.md");
    expect(md).toContain("- Score: 7 / 20");
    expect(md).toContain("> Embedded");
  });
});

describe("full course pull: unknown is never none", () => {
  it("an unreadable assignment list is reported, Content still syncs, and nothing says there are no assignments", async () => {
    const toc = { Modules: [], Topics: [fileTopic(10, url("A.pdf"))] };
    const result = await run({ toc, topics: { 10: ok("a") }, routes: { [FOLDERS]: status(403) } });
    expect(result.assignments?.listUnreadable).toContain("403");
    expect(result.assignments?.folders).toBe(0);
    expect(await listTree(root)).toEqual(["A.pdf"]);
  });

  it("a 404 on the assignment list is a course without the tool, not unreadable", async () => {
    const result = await run({ routes: { [FOLDERS]: status(404) } });
    expect(result.assignments?.listUnreadable).toBeUndefined();
  });

  it("a 404 on mysubmissions is a known not-submitted, written as such", async () => {
    const result = await run({ routes: { [FOLDERS]: [folder(5, "Essay 2")], [subsRoute(5)]: status(404), [fbRoute(5)]: status(404) } });
    expect(result.assignments).toMatchObject({ notSubmitted: 1, unknown: [] });
    const md = await read("Assignments/Essay 2/feedback.md");
    expect(md).toContain("- Submitted: not submitted");
    expect(md).toContain("- Status: not graded yet");
    expect(md).toContain("- Files: none");
  });

  it("a 403 on mysubmissions is unknown, and feedback.md still says so", async () => {
    const result = await run({ routes: { [FOLDERS]: [folder(5, "Essay 2")], [subsRoute(5)]: status(403), [fbRoute(5)]: status(404) } });
    expect(result.assignments?.notSubmitted).toBe(0);
    expect(result.assignments?.unknown).toContainEqual(expect.objectContaining({ folderId: 5, name: "Essay 2", what: "submissions", reason: expect.stringContaining("403") }));
    const md = await read("Assignments/Essay 2/feedback.md");
    expect(md).toContain("- Submitted: unknown (");
    expect(md).not.toContain("not submitted");
  });

  it("a 403 on feedback is unknown; a 404 is known not graded", async () => {
    const result = await run({
      routes: {
        [FOLDERS]: [folder(5, "Restricted"), folder(6, "Ungraded")],
        [subsRoute(5)]: [], [fbRoute(5)]: status(403),
        [subsRoute(6)]: [], [fbRoute(6)]: status(404),
      },
    });
    expect(result.assignments?.unknown).toEqual([expect.objectContaining({ folderId: 5, what: "feedback" })]);
    expect(await read("Assignments/Restricted/feedback.md")).toContain("- Score: unknown (");
    expect(await read("Assignments/Ungraded/feedback.md")).toContain("- Score: not graded yet");
  });

  it("skips a hidden folder and counts it", async () => {
    const result = await run({ routes: { [FOLDERS]: [folder(5, "Hidden", { IsHidden: true })] } });
    expect(result.assignments).toMatchObject({ hiddenFoldersSkipped: 1, folders: 0 });
    expect(await listTree(root)).toEqual([]);
  });

  it("a group folder saves files, names the submitter, and marks the skipped student feedback route as unknown", async () => {
    const setup = essay();
    setup.routes![FOLDERS] = [folder(5, "Group project", { GroupTypeId: 9 })];
    delete setup.routes![fbRoute(5)];
    setup.routes![subsRoute(5)] = [submission(3, [{ FileId: 11, FileName: "Report.pdf" }], "B. Groupmate")];
    const result = await run(setup);
    expect(result.assignments).toMatchObject({ groupFolders: 1, submissionFilesDownloaded: 1 });
    expect(result.assignments?.unknown).toEqual([expect.objectContaining({ what: "feedback", reason: expect.stringContaining("group") })]);
    const tree = await listTree(root);
    expect(tree).toContain("Assignments/Group project/submission files/Report.pdf");
    const md = await read("Assignments/Group project/feedback.md");
    expect(md).toContain('by "B. Groupmate"');
    expect(md.toLowerCase()).not.toContain("your submission");
    expect(fake!.client.get.mock.calls.some((c: unknown[]) => String(c[0]).includes("/feedback/user/"))).toBe(false);
  });

  it("a feedback attachment route that fails is unknown feedbackFiles, never none, and the rest is saved", async () => {
    const setup = essay();
    delete setup.files![route("/dropbox/folders/5/feedback/user/77/attachments/31")];
    setup.routes!["/d2l/api/lp/1.99/users/whoami"] = status(500);
    const result = await run(setup);
    expect(result.assignments?.unknown).toEqual([expect.objectContaining({ folderId: 5, what: "feedbackFiles" })]);
    expect(await read("Assignments/Essay 2/feedback.md")).toContain("## Feedback files\nunknown (");
    expect(result.assignments?.submissionFilesDownloaded).toBe(1);
  });

  it("an unreadable attachment list on the folder is unknown attachments", async () => {
    const setup = essay();
    setup.routes![FOLDERS] = [folder(5, "Essay 2", { Attachments: "oops" })];
    const result = await run(setup, { includeAssignmentFiles: true });
    expect(result.assignments?.unknown).toEqual(expect.arrayContaining([expect.objectContaining({ what: "attachments" })]));
  });

  it("one file refused is failed by name, the others are saved", async () => {
    const setup = essay();
    setup.files![subFile(5, 3, 11)] = { status: 403 };
    const result = await run(setup, { includeAssignmentFiles: true });
    expect(result.failed).toEqual([{ path: "Assignments/Essay 2/my files/Essay.docx", error: expect.stringContaining("403") }]);
    expect(result.assignments?.assignmentFilesDownloaded).toBe(1);
    const md = await read("Assignments/Essay 2/feedback.md");
    expect(md).not.toContain('"my files/Essay.docx"');
    expect(md).toContain("Files not saved: 1");
  });

  it("a zero-byte file is empty on Brightspace, not a failure", async () => {
    const setup = essay();
    setup.files![subFile(5, 3, 11)] = { body: Buffer.alloc(0) };
    const result = await run(setup);
    expect(result.emptyOnBrightspace).toBe(1);
    expect(result.failed).toEqual([]);
  });
});

describe("full course pull: caps and stops are shared with Content", () => {
  const toc = { Modules: [], Topics: [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf"))] };

  it("maxFiles counts Content and extras together", async () => {
    const result = await run({ ...essay(), toc, topics: { 10: ok("a"), 11: ok("b") } }, { maxFiles: 3, includeAssignmentFiles: true });
    const files = (await listTree(root)).filter((e) => !e.endsWith("/") && !e.endsWith("feedback.md"));
    expect(files).toHaveLength(3);
    // Content A and B and the submission use the three; the assignment file and the feedback file are left.
    expect(result.notAttempted).toBe(2);
    expect(result.downloaded.filter((f) => !f.path.endsWith("feedback.md"))).toHaveLength(3);
  });

  it("maxTotalBytes stops the extras phase too", async () => {
    const result = await run({ ...essay(), toc, topics: { 10: ok("a"), 11: ok("b") } }, { maxTotalBytes: 1 });
    expect(result.stopped).toBe("max_total_bytes");
    expect(result.assignments).toMatchObject({ notRun: "max_total_bytes", folders: 0, foldersNotReached: 0 });
    expect(await listTree(root)).toEqual([]);
  });

  it("a cancel before the extras phase leaves the phase not run", async () => {
    const controller = new AbortController();
    const result = await run({ ...essay(), toc, topics: { 10: ok("a"), 11: ok("b") } }, {
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === "downloaded") controller.abort();
      },
    });
    expect(result.stopped).toBe("cancelled");
    expect(result.assignments).toMatchObject({ notRun: "cancelled", folders: 0, foldersNotReached: 0 });
    expect(await listTree(root)).not.toContain("Assignments/");
  });

  it("a lost sign-in while reading the assignment list stops with the sign-in text and keeps what was saved", async () => {
    const { ApiError } = await import("../../src/api/errors.js");
    const result = await run({ toc, topics: { 10: ok("a"), 11: ok("b") }, routes: { [FOLDERS]: new ApiError(401, "/x", "expired") } });
    expect(result.stopped).toBe("auth");
    expect(result.authError).toBeTruthy();
    expect(await listTree(root)).toEqual(["A.pdf", "B.pdf"]);
  });

  it("a lost sign-in on a later route stops the phase after the folders already done", async () => {
    const { ApiError } = await import("../../src/api/errors.js");
    const setup = essay();
    setup.routes![FOLDERS] = [folder(4, "First"), folder(5, "Essay 2")];
    setup.routes![subsRoute(4)] = status(404);
    setup.routes![fbRoute(4)] = status(404);
    setup.routes![subsRoute(5)] = new ApiError(401, "/x", "expired");
    const result = await run(setup);
    expect(result.stopped).toBe("auth");
    expect(result.assignments).toMatchObject({ folders: 1, foldersPartlySaved: 1, foldersNotReached: 0 });
    expect(await listTree(root)).toContain("Assignments/First/feedback.md");
  });
});

describe("full course pull: feedback.md refresh and reruns", () => {
  const mdPath = "Assignments/Essay 2/feedback.md";

  it("a rerun skips files on disk and writes nothing when feedback.md is unchanged", async () => {
    await run(essay());
    const before = await fs.stat(path.join(root, ...mdPath.split("/")));
    const result = await again(() => {});
    expect(result.assignments).toMatchObject({ feedbackUnchanged: 1, feedbackWritten: 0, submissionFilesDownloaded: 0 });
    // The submitted file and the feedback attachment are on disk; feedback.md is unchanged, which is not a skip.
    expect(result.skippedExisting).toBe(2);
    expect((await fs.stat(path.join(root, ...mdPath.split("/")))).mtimeMs).toBe(before.mtimeMs);
  });

  it("refreshes feedback.md when the feedback changed and the file is untouched", async () => {
    await run(essay());
    const result = await again((e) => {
      e.routes[fbRoute(5)] = { IsGraded: true, Score: 19, Feedback: { Text: "Regraded.", Html: "" } };
    });
    expect(result.assignments).toMatchObject({ feedbackRefreshed: 1, feedbackEditedNotRefreshed: 0 });
    const md = await read(mdPath);
    expect(md).toContain("- Score: 19 / 20");
    expect(md).toContain("> Regraded.");
    expect(await fs.readdir(path.join(root, "Assignments", "Essay 2"))).not.toContainEqual(expect.stringContaining(".tmp-"));
  });

  it("never touches a feedback.md the student edited, and says so", async () => {
    await run(essay());
    await fs.appendFile(path.join(root, ...mdPath.split("/")), "\nMy notes\n");
    const edited = await read(mdPath);
    const result = await again((e) => {
      e.routes[fbRoute(5)] = { IsGraded: true, Score: 19, Feedback: { Text: "Regraded.", Html: "" } };
    });
    expect(result.assignments?.feedbackEditedNotRefreshed).toBe(1);
    expect(await read(mdPath)).toBe(edited);
  });

  it("existing: replace follows the same gate (refreshes untouched, leaves edited)", async () => {
    await run(essay());
    const result = await again((e) => {
      e.routes[fbRoute(5)] = { IsGraded: true, Score: 3, Feedback: { Text: "Again.", Html: "" } };
    }, { existing: "replace" });
    expect(result.assignments?.feedbackRefreshed).toBe(1);
    await fs.appendFile(path.join(root, ...mdPath.split("/")), "x");
    const result2 = await again((e) => {
      e.routes[fbRoute(5)] = { IsGraded: true, Score: 4, Feedback: { Text: "Again 2.", Html: "" } };
    }, { existing: "replace" });
    expect(result2.assignments?.feedbackEditedNotRefreshed).toBe(1);
  });

  it("leaves a file that is on disk with no manifest record alone, as the student's own", async () => {
    await run(essay(), { includeAssignmentFiles: true });
    // What an older server does: it rewrites the manifest without the extras key.
    const file = path.join(root, ".brightspace-sync.json");
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ version: parsed.version, courses: parsed.courses }));
    const before = await read(mdPath);
    const result = await again((e) => {
      e.routes[fbRoute(5)] = { IsGraded: true, Score: 1, Feedback: { Text: "Different.", Html: "" } };
    }, { includeAssignmentFiles: true });
    expect(await read(mdPath)).toBe(before);
    expect(result.downloaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.assignments?.feedbackWritten).toBe(0);
  });

  it("follows an assignment renamed on Brightspace: same folder, no new one", async () => {
    await run(essay());
    const result = await again((e) => {
      e.routes[FOLDERS] = [folder(5, "Essay 2 (final)", { Attachments: [{ FileId: 21, FileName: "Prompt.pdf", Size: 10 }] })];
    });
    expect((await listTree(root)).filter((entry) => entry.split("/").length === 3 && entry.endsWith("/"))).toEqual(["Assignments/Essay 2/"]);
    expect(result.assignments).toMatchObject({ feedbackRefreshed: 1, feedbackWritten: 0 });
    expect(await read(mdPath)).toContain('"Essay 2 (final)"');
  });

  it("writes a graded feedback.md over a not-graded-yet one", async () => {
    const setup = essay();
    setup.routes![fbRoute(5)] = status(404);
    await run(setup);
    expect(await read(mdPath)).toContain("- Status: not graded yet");
    const result = await again((e) => {
      e.routes[fbRoute(5)] = { IsGraded: true, Score: 18, Feedback: { Text: "Done.", Html: "" } };
    });
    expect(result.assignments?.feedbackRefreshed).toBe(1);
    expect(await read(mdPath)).toContain("- Status: graded");
  });
});

describe("full course pull: dry run", () => {
  it("lists what would be saved and writes and creates nothing", async () => {
    const result = await run(essay(), { dryRun: true, includeAssignmentFiles: true });
    expect(await listTree(root)).toEqual([]);
    expect(result.planned).toEqual(expect.arrayContaining([
      "Assignments/Essay 2/my files/Essay.docx",
      "Assignments/Essay 2/assignment files/Prompt.pdf",
      "Assignments/Essay 2/feedback.md",
    ]));
    expect(fake!.rawRequests).toEqual([]);
  });
});
