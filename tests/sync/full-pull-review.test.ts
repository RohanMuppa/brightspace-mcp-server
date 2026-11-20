import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../../src/api/errors.js";
import { syncCourse, type SyncOptions, type SyncResult } from "../../src/sync/course-sync.js";
import { summarizeSync } from "../../src/sync/summary.js";
import { fileTopic, listTree, pdf, tempRoot, type Fake, type Step } from "./harness.js";
import { fakeCourse, folder, news, route, status, submission, type Extras } from "./extras-harness.js";

let parent: string;
let root: string;
let fake: (Fake & { rawRequests: string[] }) | undefined;
const extras: Extras = { routes: {}, files: {} };

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
const NEWS = route("/news/");
const subsRoute = (id: number) => route(`/dropbox/folders/${id}/submissions/mysubmissions/`);
const fbRoute = (id: number) => route(`/dropbox/folders/${id}/feedback/myFeedback/`);
const subFile = (f: number, s: number, file: number) => route(`/dropbox/folders/${f}/submissions/${s}/files/${file}`);
const WHOAMI = "/d2l/api/lp/1.99/users/whoami";
const mdPath = "Assignments/Essay 2/feedback.md";

interface Setup {
  toc?: unknown;
  topics?: Record<number, Step | Step[]>;
  routes?: Record<string, unknown>;
  files?: Record<string, Step | Step[]>;
  contentDelayMs?: number;
}

async function start(setup: Setup): Promise<void> {
  extras.routes = { ...(setup.routes ?? {}) };
  extras.files = { ...(setup.files ?? {}) };
  extras.contentDelayMs = setup.contentDelayMs;
  fake = await fakeCourse(setup.toc ?? { Modules: [], Topics: [] }, setup.topics ?? {}, extras);
}
const sync = (options: Partial<SyncOptions> = {}): Promise<SyncResult> =>
  syncCourse(fake!.client, { courseId: 42, destination: root, sleep: async () => {}, retryDelaysMs: [], includeSubmissions: true, ...options });
async function run(setup: Setup, options: Partial<SyncOptions> = {}): Promise<SyncResult> {
  await start(setup);
  return sync(options);
}
const read = (rel: string) => fs.readFile(path.join(root, ...rel.split("/")), "utf8");
const getPaths = () => fake!.client.get.mock.calls.map((c: unknown[]) => String(c[0]));
const extraReads = () => getPaths().filter((p) => p.includes("/dropbox/") || p.includes("/news/"));

const essay = (over: Record<string, unknown> = {}): Setup => ({
  routes: {
    [FOLDERS]: [folder(5, "Essay 2", { Attachments: [{ FileId: 21, FileName: "Prompt.pdf" }] })],
    [subsRoute(5)]: [submission(3, [{ FileId: 11, FileName: "Essay.docx" }])],
    [fbRoute(5)]: { IsGraded: true, Score: 18, Feedback: { Text: "Good.", Html: "" }, Files: [{ FileId: 31, FileName: "Marked-up.pdf" }] },
    [WHOAMI]: { Identifier: 77 },
    [NEWS]: [news(8, "Slides", [{ FileId: 41, FileName: "Slides.pdf" }])],
    ...over,
  },
  files: {
    [subFile(5, 3, 11)]: ok("sub"),
    [route("/dropbox/folders/5/attachments/21")]: ok("asg"),
    [route("/dropbox/folders/5/feedback/user/77/attachments/31")]: ok("fb"),
    [route("/news/8/attachments/41")]: ok("news"),
  },
});
const twoContent = { toc: { Modules: [], Topics: [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf"))] }, topics: { 10: ok("a"), 11: ok("b") } };
const all = { includeAssignmentFiles: true, includeAnnouncementFiles: true };

describe("H1: a stop before the extras phases is 'not run', never zero", () => {
  const expectNotRun = (result: SyncResult, why: string) => {
    expect(result.assignments).toMatchObject({ notRun: why, folders: 0 });
    expect(result.announcements).toMatchObject({ notRun: why, read: 0 });
    expect(extraReads()).toEqual([]);
    const text = summarizeSync(result);
    expect(text).toContain("Assignments were not checked because the run stopped");
    expect(text).toContain("Announcements were not checked because the run stopped");
    expect(text).toMatch(/run it again/i);
    expect(text).not.toMatch(/Assignments: 0 assignments read/);
    expect(text).not.toMatch(/Announcements: 0 announcements read/);
  };

  it("after a cancel", async () => {
    const controller = new AbortController();
    const result = await run({ ...essay(), ...twoContent }, {
      ...all, signal: controller.signal,
      onProgress: (event) => { if (event.type === "downloaded") controller.abort(); },
    });
    expectNotRun(result, "cancelled");
  });

  it("after the time limit", async () => {
    const result = await run({ ...essay(), ...twoContent, contentDelayMs: 60 }, { ...all, deadlineMs: 25 });
    expect(result.stopped).toBe("deadline");
    expectNotRun(result, "deadline");
    expect(summarizeSync(result)).toContain("time limit");
  });

  it("after the byte limit", async () => {
    const result = await run({ ...essay(), ...twoContent }, { ...all, maxTotalBytes: 1 });
    expect(result.stopped).toBe("max_total_bytes");
    expectNotRun(result, "max_total_bytes");
  });

  it("after the file cap", async () => {
    const result = await run({ ...essay(), ...twoContent }, { ...all, maxFiles: 1 });
    expectNotRun(result, "max_files");
    expect(summarizeSync(result)).toContain("file cap");
  });

  it("after a lost sign-in", async () => {
    const result = await run({ ...essay(), ...twoContent, topics: { 10: { status: 401 }, 11: ok("b") } }, all);
    expect(result.stopped).toBe("auth");
    expectNotRun(result, "auth");
  });

  it("when the stop lands on the list request itself", async () => {
    const controller = new AbortController();
    const setup = essay({
      [FOLDERS]: async () => {
        controller.abort();
        throw controller.signal.reason;
      },
    });
    const result = await run(setup, { ...all, signal: controller.signal });
    expect(result.assignments).toMatchObject({ notRun: "cancelled", folders: 0 });
    expect(result.assignments?.listUnreadable).toBeUndefined();
    expect(result.announcements?.notRun).toBe("cancelled");
    expect(getPaths().filter((p) => p.includes("/news/"))).toEqual([]);
  });

  it("with the phases on and no stop, notRun is absent", async () => {
    const result = await run(essay(), all);
    expect(result.assignments?.notRun).toBeUndefined();
    expect(result.announcements?.notRun).toBeUndefined();
  });
});

describe("H2: a failed fallback feedback read is unknown, not 'not graded yet'", () => {
  it.each([[500, "Brightspace answered 500"], [403, "Brightspace refused the request: 403"]])("user route %s", async (code, reason) => {
    const setup = essay({
      [fbRoute(5)]: status(404),
      [route("/dropbox/folders/5/feedback/user/77")]: status(code),
    });
    const result = await run(setup);
    expect(result.assignments?.unknown).toContainEqual(expect.objectContaining({ what: "feedback", reason: expect.stringContaining(reason) }));
    const md = await read(mdPath);
    expect(md).toContain("- Score: unknown (");
    expect(md).not.toContain("Not graded yet");
    expect(md).not.toContain("not graded yet");
  });

  it("the user lookup failing is unknown too", async () => {
    const result = await run(essay({ [fbRoute(5)]: status(404), [WHOAMI]: status(500) }));
    expect(result.assignments?.unknown).toContainEqual(expect.objectContaining({ what: "feedback" }));
  });

  it("a 404 from the user route is a known absence", async () => {
    const result = await run(essay({ [fbRoute(5)]: status(404), [route("/dropbox/folders/5/feedback/user/77")]: status(404) }));
    expect(result.assignments?.unknown).toEqual([]);
    expect(await read(mdPath)).toContain("- Status: not graded yet");
  });
});

describe("M3: an absent field is unknown, only an empty list is none", () => {
  it("a submission with no usable id is counted unknown, not dropped", async () => {
    const result = await run(essay({ [subsRoute(5)]: [submission(0, [{ FileId: 11, FileName: "Essay.docx" }])] }));
    expect(result.assignments?.unknown).toContainEqual(expect.objectContaining({ what: "submissions" }));
    expect(await read(mdPath)).toContain("- Files: unknown (");
  });

  it("a submission with no Files field is unknown; an empty Files list is none", async () => {
    const noFiles = { ...submission(3, []), Files: undefined };
    const bad = await run(essay({ [subsRoute(5)]: [noFiles] }));
    expect(bad.assignments?.unknown).toContainEqual(expect.objectContaining({ what: "submissions", reason: "Brightspace's answer had no file list" }));
    expect(await read(mdPath)).toContain("- Files: unknown (Brightspace's answer had no file list)");
    await fake?.close();
    await fs.rm(root, { recursive: true });
    await fs.mkdir(root);
    const empty = await run(essay({ [subsRoute(5)]: [submission(3, [])] }));
    expect(empty.assignments?.unknown).toEqual([]);
    expect(await read(mdPath)).toContain("- Files: none");
  });

  it("a folder with no usable id is counted unknown", async () => {
    const result = await run(essay({ [FOLDERS]: [{ ...folder(5, "Broken"), Id: "x" }] }));
    expect(result.assignments?.unknown).toContainEqual(expect.objectContaining({ name: "Broken", what: "submissions" }));
    expect(result.assignments?.folders).toBe(0);
  });

  it("a folder with no Attachments field is unknown attachments, an empty one is none", async () => {
    const { Attachments: _drop, ...bare } = folder(5, "Essay 2");
    const result = await run(essay({ [FOLDERS]: [bare] }), { includeAssignmentFiles: true });
    expect(result.assignments?.unknown).toContainEqual(expect.objectContaining({ what: "attachments", reason: "Brightspace's answer had no file list" }));
  });

  it("feedback with no Files field is unknown feedbackFiles, and feedback.md says so", async () => {
    const result = await run(essay({ [fbRoute(5)]: { IsGraded: true, Score: 1, Feedback: { Text: "x", Html: "" } } }));
    expect(result.assignments?.unknown).toContainEqual(expect.objectContaining({ what: "feedbackFiles" }));
    expect(await read(mdPath)).toContain("## Feedback files\nunknown (Brightspace's answer had no file list)");
  });

  it("feedback with an empty Files list is none", async () => {
    const result = await run(essay({ [fbRoute(5)]: { IsGraded: true, Score: 1, Feedback: { Text: "x", Html: "" }, Files: [] } }));
    expect(result.assignments?.unknown).toEqual([]);
    expect(await read(mdPath)).not.toContain("## Feedback files");
  });

  it("an announcement with no Attachments field or no usable id is unknown", async () => {
    const { Attachments: _drop, ...bare } = news(8, "Bare", []);
    const result = await run(essay({ [NEWS]: [bare, news(0, "No id", [])] }), { includeSubmissions: false, includeAnnouncementFiles: true });
    expect(result.announcements?.unknown).toEqual([
      expect.objectContaining({ newsId: 8, title: "Bare", reason: "Brightspace's answer had no file list" }),
      expect.objectContaining({ newsId: 0, title: "No id" }),
    ]);
    expect(result.announcements?.withFiles).toBe(0);
  });
});

describe("M4: not-saved counts are per kind", () => {
  it("the submission line counts submission files only, and the feedback section counts its own", async () => {
    const setup = essay({
      [fbRoute(5)]: { IsGraded: true, Score: 1, Feedback: { Text: "x", Html: "" }, Files: [{ FileId: 31, FileName: "A.pdf" }, { FileId: 32, FileName: "B.pdf" }] },
    });
    setup.files![route("/dropbox/folders/5/feedback/user/77/attachments/32")] = { status: 403 };
    const result = await run(setup, { includeAssignmentFiles: true });
    const md = await read(mdPath);
    expect(md).not.toContain("Files not saved");
    expect(md).toContain('## Feedback files\n- "feedback files/A.pdf"');
    expect(md).toContain("1 listed by Brightspace could not be saved");
    expect(result.failed).toHaveLength(1);
    expect(result.assignments?.unknown).toEqual([]);
  });

  it("a failed submission file shows on the submission line only", async () => {
    const setup = essay();
    setup.files![subFile(5, 3, 11)] = { status: 403 };
    await run(setup, { includeAssignmentFiles: true });
    const md = await read(mdPath);
    expect(md).toContain("- Files not saved: 1");
    expect(md).toContain('"feedback files/Marked-up.pdf"');
    expect(md).not.toMatch(/## Feedback files[\s\S]*could not be saved/);
  });

  it("a failed assignment file is counted in its own section", async () => {
    const setup = essay();
    setup.files![route("/dropbox/folders/5/attachments/21")] = { status: 404 };
    await run(setup, { includeAssignmentFiles: true });
    const md = await read(mdPath);
    expect(md).toContain("## Assignment files");
    expect(md).toContain("1 listed by Brightspace could not be saved");
    expect(md).not.toContain("Files not saved");
  });
});

describe("M5: caps stop the phase", () => {
  const folders = (n: number) => {
    const routes: Record<string, unknown> = { [FOLDERS]: Array.from({ length: n }, (_, i) => folder(i + 4, `Work ${i + 4}`)), [WHOAMI]: { Identifier: 77 } };
    const files: Record<string, Step> = {};
    for (let i = 0; i < n; i++) {
      const id = i + 4;
      routes[subsRoute(id)] = [submission(id * 10, [{ FileId: id * 100, FileName: `f${id}.pdf` }, ...(id === 5 ? [{ FileId: 999, FileName: "g.pdf" }] : [])])];
      routes[fbRoute(id)] = status(404);
      files[subFile(id, id * 10, id * 100)] = ok(String(id));
      files[subFile(id, id * 10, 999)] = ok("g");
    }
    return { routes, files };
  };

  it("stops reading further folders at the file cap, and writes no feedback.md for them", async () => {
    const setup = folders(3);
    (setup.routes as any)[subsRoute(5)][0].Files.splice(1, 1);
    const result = await run(setup, { maxFiles: 2 });
    expect(result.assignments).toMatchObject({ folders: 2, foldersNotReached: 1, foldersPartlySaved: 0 });
    const tree = await listTree(root);
    expect(tree).toContain("Assignments/Work 4/feedback.md");
    expect(tree).toContain("Assignments/Work 5/feedback.md");
    expect(tree.some((e) => e.includes("Work 6"))).toBe(false);
    expect(getPaths().some((p) => p.includes("/dropbox/folders/6/"))).toBe(false);
  });

  it("a folder cut short by the cap is partly saved, has no feedback.md, and later folders are not reached", async () => {
    const setup = folders(3);
    const result = await run(setup, { maxFiles: 2 });
    // Work 4 takes one file, Work 5 has two and gets the second slot only.
    expect(result.assignments).toMatchObject({ folders: 1, foldersPartlySaved: 1, foldersNotReached: 1 });
    expect(result.notAttempted).toBe(1);
    const tree = await listTree(root);
    expect(tree).toContain("Assignments/Work 4/feedback.md");
    expect(tree.some((e) => e.endsWith("Work 5/feedback.md") || e.includes("Work 6"))).toBe(false);
    const text = summarizeSync(result);
    expect(text).toContain("partly saved");
  });

  it("does not stop reading when only the cap is not reached", async () => {
    const result = await run(folders(3), { maxFiles: 50 });
    expect(result.assignments).toMatchObject({ folders: 3, foldersNotReached: 0, foldersPartlySaved: 0 });
  });
});

describe("M6: feedback.md in every existing mode", () => {
  const changed = { IsGraded: true, Score: 3, Feedback: { Text: "Again.", Html: "" }, Files: [] };
  const regrade = (e: Extras) => { e.routes[fbRoute(5)] = changed; };
  const again = (change: (e: Extras) => void, options: Partial<SyncOptions> = {}) => { change(extras); return sync(options); };

  it.each(["skip", "replace", "keep_both"] as const)("refreshes an unedited feedback.md in place under %s", async (existing) => {
    await run(essay(), {});
    const result = await again(regrade, { existing });
    expect(result.assignments?.feedbackRefreshed).toBe(1);
    expect(await read(mdPath)).toContain("> Again.");
    expect((await fs.readdir(path.join(root, "Assignments", "Essay 2"))).filter((n) => n.startsWith("feedback") && n.endsWith(".md"))).toEqual(["feedback.md"]);
  });

  it.each(["skip", "replace"] as const)("leaves an edited feedback.md alone under %s and reports it", async (existing) => {
    await run(essay(), {});
    await fs.appendFile(path.join(root, ...mdPath.split("/")), "\nmine\n");
    const before = await read(mdPath);
    const result = await again(regrade, { existing });
    expect(result.assignments).toMatchObject({ feedbackEditedNotRefreshed: 1, feedbackRefreshed: 0 });
    expect(await read(mdPath)).toBe(before);
  });

  it("under keep_both an edited feedback.md gets the new text in feedback (2).md, which is then refreshed in place", async () => {
    await run(essay(), {});
    await fs.appendFile(path.join(root, ...mdPath.split("/")), "\nmine\n");
    const edited = await read(mdPath);
    const first = await again(regrade, { existing: "keep_both" });
    expect(first.assignments?.feedbackWritten).toBe(1);
    expect(await read(mdPath)).toBe(edited);
    expect(await read("Assignments/Essay 2/feedback (2).md")).toContain("> Again.");
    const second = await again((e) => { e.routes[fbRoute(5)] = { ...changed, Score: 4, Feedback: { Text: "Third.", Html: "" } }; }, { existing: "keep_both" });
    expect(second.assignments?.feedbackRefreshed).toBe(1);
    expect(await read("Assignments/Essay 2/feedback (2).md")).toContain("> Third.");
    const names = (await fs.readdir(path.join(root, "Assignments", "Essay 2"))).filter((n) => n.startsWith("feedback") && n.endsWith(".md")).sort();
    expect(names).toEqual(["feedback (2).md", "feedback.md"]);
    const third = await again(() => {}, { existing: "keep_both" });
    expect(third.assignments?.feedbackUnchanged).toBe(1);
  });
});

describe("L1 to L3", () => {
  it("L1: a stop mid-announcement counts it as partly saved and the rest as not reached", async () => {
    const controller = new AbortController();
    const result = await run(
      essay({ [NEWS]: [news(8, "One", [{ FileId: 41, FileName: "A.pdf" }, { FileId: 42, FileName: "B.pdf" }]), news(9, "Two", [{ FileId: 43, FileName: "C.pdf" }])] }),
      { includeSubmissions: false, includeAnnouncementFiles: true, signal: controller.signal, onProgress: (event) => { if (event.type === "downloaded") controller.abort(); } },
    );
    extras.files[route("/news/8/attachments/42")] = ok("b");
    expect(result.announcements).toMatchObject({ filesDownloaded: 1, partlySaved: 1, notReached: 1 });
    expect(summarizeSync(result)).toContain("partly saved");
  });

  it("L2: feedback that is not released saves no feedback attachments", async () => {
    const result = await run(essay({ [fbRoute(5)]: { IsGraded: false, Score: 1, Feedback: { Text: "draft", Html: "" }, Files: [{ FileId: 31, FileName: "Marked-up.pdf" }] } }));
    expect(fake!.rawRequests.some((p) => p.includes("/feedback/"))).toBe(false);
    expect(result.assignments?.feedbackFilesDownloaded).toBe(0);
    expect(result.assignments?.unknown).toEqual([]);
    expect(await read(mdPath)).toContain("- Status: not graded yet");
  });

  it("L3: the user lookup for feedback attachments gets the abort signal", async () => {
    await run(essay());
    const call = fake!.client.get.mock.calls.find((c: unknown[]) => String(c[0]).endsWith("/users/whoami"));
    expect((call![1] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it("L5: a missing Files field and a failing fallback together are both unknown", async () => {
    const result = await run(essay({ [fbRoute(5)]: status(404), [route("/dropbox/folders/5/feedback/user/77")]: status(500) }));
    expect(result.assignments?.unknown.map((u) => u.what)).toEqual(["feedback"]);
    expect(ApiError).toBeDefined();
  });
});

describe("M8: Content keeps its names, the extras take the first free root", () => {
  const module_ = (title: string, topics: unknown[]) => ({ ModuleId: 1, Title: title, Topics: topics, Modules: [] });
  const toc = (...topics: unknown[]) => ({ Modules: [module_("Assignments", topics)], Topics: [] });

  it("an existing sync with a module named Assignments keeps its files there when the option is turned on later", async () => {
    await start({ ...essay(), toc: toc(fileTopic(10, url("Intro.pdf"))), topics: { 10: ok("a"), 11: ok("b") } });
    const first = await sync({ includeSubmissions: false });
    expect(await listTree(root)).toEqual(["Assignments/", "Assignments/Intro.pdf"]);
    expect(first.assignments).toBeUndefined();

    // The module gains a file, and the extras are turned on.
    fake!.client.get.mockImplementation(async (p: string, options?: unknown) => {
      if (p.endsWith("/content/toc")) return toc(fileTopic(10, url("Intro.pdf")), fileTopic(11, url("More.pdf")));
      if (p in extras.routes) return extras.routes[p];
      throw new ApiError(404, p, "not found");
    });
    const second = await sync({ includeSubmissions: true });
    const tree = await listTree(root);
    expect(tree).toContain("Assignments/Intro.pdf");
    expect(tree).toContain("Assignments/More.pdf");
    expect(tree).toContain("Assignments (2)/Essay 2/feedback.md");
    expect(tree).not.toContain("Assignments (2)/Intro.pdf");
    expect(second.assignments?.folder).toBe("Assignments (2)");
    expect(summarizeSync(second)).toContain('Saved in the folder "Assignments (2)"');
  });

  it("the chosen root is recorded, so it stays the same on the next run", async () => {
    await start({ ...essay(), toc: toc(fileTopic(10, url("Intro.pdf"))), topics: { 10: ok("a") } });
    await sync();
    // The module is gone from the course now: the recorded root still stands.
    fake!.client.get.mockImplementation(async (p: string) => {
      if (p.endsWith("/content/toc")) return { Modules: [], Topics: [] };
      if (p in extras.routes) return extras.routes[p];
      throw new ApiError(404, p, "not found");
    });
    const second = await sync();
    expect(second.assignments?.folder).toBe("Assignments (2)");
    expect(second.assignments?.feedbackUnchanged).toBe(1);
    const manifest = JSON.parse(await fs.readFile(path.join(root, ".brightspace-sync.json"), "utf8"));
    expect(manifest.extras["42"].assignmentsRoot).toBe("Assignments (2)");
  });

  it("without a clash the roots are plain Assignments and Announcements", async () => {
    const result = await run(essay(), { includeAnnouncementFiles: true });
    expect([result.assignments?.folder, result.announcements?.folder]).toEqual(["Assignments", "Announcements"]);
  });

  it("a Content module named Announcements pushes only the announcements root aside", async () => {
    const result = await run({ ...essay(), toc: { Modules: [{ ModuleId: 2, Title: "Announcements", Topics: [fileTopic(10, url("A.pdf"))], Modules: [] }], Topics: [] }, topics: { 10: ok("a") } }, { includeAnnouncementFiles: true });
    expect([result.assignments?.folder, result.announcements?.folder]).toEqual(["Assignments", "Announcements (2)"]);
    const tree = await listTree(root);
    expect(tree).toContain("Announcements/A.pdf");
    expect(tree).toContain("Announcements (2)/2026-10-01 Slides/Slides.pdf");
  });
});

describe("M7: extras names fit the path budget", () => {
  it("shortens folder and file names instead of failing", async () => {
    const budget = 0 + 70;
    const long = "A".repeat(200);
    const setup = essay({
      [FOLDERS]: [folder(5, long, { Attachments: [{ FileId: 21, FileName: `${"P".repeat(200)}.pdf` }] })],
      [subsRoute(5)]: [submission(3, [{ FileId: 11, FileName: `${"F".repeat(200)}.docx` }])],
      [NEWS]: [news(8, "T".repeat(200), [{ FileId: 41, FileName: `${"S".repeat(200)}.pdf` }])],
    });
    await start(setup);
    const real = await fs.realpath(root);
    const limit = real.length + budget;
    const result = await sync({ ...all, pathBudget: limit });
    expect(result.failed).toEqual([]);
    const files = (await listTree(root)).filter((e) => !e.endsWith("/"));
    expect(files.filter((f) => f.endsWith(".docx") || f.endsWith(".pdf") || f.endsWith("feedback.md"))).toHaveLength(5);
    for (const rel of files) expect(real.length + 1 + rel.length).toBeLessThanOrEqual(limit);
    expect(files.some((f) => f.endsWith(".pdf") && f.includes("assignment files"))).toBe(true);
    // The extension survives the shortening.
    expect(files.filter((f) => f.includes("my files")).every((f) => f.endsWith(".docx"))).toBe(true);
  });

  it("a budget too small for any name still fails per file, naming the path", async () => {
    const result = await run(essay(), { pathBudget: (await fs.realpath(root)).length + 12 });
    expect(result.failed.length).toBeGreaterThan(0);
    expect(result.failed[0].error).toMatch(/too long/);
  });
});

describe("a folder made by 5.2.21 re-syncs without loss", () => {
  const withModule = (title: string) => ({ Modules: [{ ModuleId: 1, Title: title, Topics: [fileTopic(10, url("Intro.pdf"))], Modules: [] }], Topics: [] });

  it("re-downloads nothing, moves nothing and still owns the extras", async () => {
    // 5.2.21 saved the module called "Assignments" as "Assignments (2)" and put the extras in "Assignments", with no recorded root.
    await start({ ...essay(), toc: withModule("Assignments (2)"), topics: { 10: ok("a") } });
    await sync();
    const file = path.join(root, ".brightspace-sync.json");
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    delete parsed.extras["42"].assignmentsRoot;
    delete parsed.extras["42"].announcementsRoot;
    await fs.writeFile(file, JSON.stringify(parsed));
    const before = await listTree(root);
    const mdBefore = await read(mdPath);
    const mtime = (await fs.stat(path.join(root, ...mdPath.split("/")))).mtimeMs;

    // 5.2.22 plans the same module as "Assignments".
    fake!.client.get.mockImplementation(async (p: string) => {
      if (p.endsWith("/content/toc")) return withModule("Assignments");
      if (p in extras.routes) return extras.routes[p];
      throw new ApiError(404, p, "not found");
    });
    const result = await sync({ existing: "skip" });
    expect(result.downloaded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(await listTree(root)).toEqual(before);
    expect(before).toContain("Assignments (2)/Intro.pdf");
    expect(before).not.toContain("Assignments/Intro.pdf");
    expect(result.assignments).toMatchObject({ folder: "Assignments", feedbackUnchanged: 1, feedbackWritten: 0, unknown: [] });
    expect(await read(mdPath)).toBe(mdBefore);
    expect((await fs.stat(path.join(root, ...mdPath.split("/")))).mtimeMs).toBe(mtime);
    const after = JSON.parse(await fs.readFile(file, "utf8"));
    expect(after.extras["42"].assignmentsRoot).toBe("Assignments");
    expect(Object.keys(after.extras["42"].assignments["5"].files).sort()).toEqual(["fb:31", "sub:3:11"]);
  });

  it("a later graded run still refreshes that feedback.md", async () => {
    await start({ ...essay() });
    await sync();
    const file = path.join(root, ".brightspace-sync.json");
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    delete parsed.extras["42"].assignmentsRoot;
    await fs.writeFile(file, JSON.stringify(parsed));
    extras.routes[fbRoute(5)] = { IsGraded: true, Score: 19, Feedback: { Text: "Regraded.", Html: "" }, Files: [] };
    const result = await sync();
    expect(result.assignments?.feedbackRefreshed).toBe(1);
    expect(await read(mdPath)).toContain("- Score: 19 / 20");
  });
});
