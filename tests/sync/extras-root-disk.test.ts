import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { syncCourse, type SyncOptions, type SyncResult } from "../../src/sync/course-sync.js";
import { summarizeSync } from "../../src/sync/summary.js";
import { listTree, pdf, tempRoot, type Fake, type Step } from "./harness.js";
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
const FOLDERS = route("/dropbox/folders/");

const course = (): { routes: Record<string, unknown>; files: Record<string, Step> } => ({
  routes: {
    [FOLDERS]: [folder(5, "Essay 2")],
    [route("/dropbox/folders/5/submissions/mysubmissions/")]: [submission(3, [{ FileId: 11, FileName: "Essay.docx" }])],
    [route("/dropbox/folders/5/feedback/myFeedback/")]: status(404),
    [route("/news/")]: [news(8, "Slides", [{ FileId: 41, FileName: "Slides.pdf" }])],
  },
  files: { [route("/dropbox/folders/5/submissions/3/files/11")]: ok("s"), [route("/news/8/attachments/41")]: ok("n") },
});

async function run(options: Partial<SyncOptions> = {}, destination = root): Promise<SyncResult> {
  const c = course();
  extras.routes = c.routes;
  extras.files = c.files;
  fake = await fakeCourse({ Modules: [], Topics: [] }, {}, extras);
  return syncCourse(fake.client, { courseId: 42, destination, sleep: async () => {}, retryDelaysMs: [], includeSubmissions: true, includeAnnouncementFiles: true, ...options });
}
const again = (options: Partial<SyncOptions> = {}) =>
  syncCourse(fake!.client, { courseId: 42, destination: root, sleep: async () => {}, retryDelaysMs: [], includeSubmissions: true, includeAnnouncementFiles: true, ...options });
const manifestOf = async () => JSON.parse(await fs.readFile(path.join(root, ".brightspace-sync.json"), "utf8"));

describe("the extras folders avoid anything already in the destination", () => {
  it("a student's own folder named assignments is not merged into", async () => {
    await fs.mkdir(path.join(root, "assignments"));
    await fs.writeFile(path.join(root, "assignments", "mine.txt"), "mine");
    const result = await run();
    expect(result.assignments?.folder).toBe("Assignments (2)");
    expect(result.announcements?.folder).toBe("Announcements");
    const tree = await listTree(root);
    expect(tree).toContain("Assignments (2)/Essay 2/feedback.md");
    expect(tree).toContain("assignments/mine.txt");
    expect(tree.filter((e) => e.startsWith("assignments/") && !e.endsWith("/"))).toEqual(["assignments/mine.txt"]);
    expect((await manifestOf()).extras["42"].assignmentsRoot).toBe("Assignments (2)");
    expect(summarizeSync(result)).toContain('Saved in the folder "Assignments (2)"');
  });

  it("a file named Announcements counts too, and only that kind moves aside", async () => {
    await fs.writeFile(path.join(root, "Announcements"), "a file");
    const result = await run();
    expect([result.assignments?.folder, result.announcements?.folder]).toEqual(["Assignments", "Announcements (2)"]);
    expect(await fs.readFile(path.join(root, "Announcements"), "utf8")).toBe("a file");
  });

  it("a symbolic link with that name counts", async () => {
    try {
      await fs.symlink(path.join(parent, "elsewhere"), path.join(root, "Assignments"));
    } catch {
      return; // Creating a link needs a privilege on some systems.
    }
    const result = await run();
    expect(result.assignments?.folder).toBe("Assignments (2)");
  });

  it.each([["ASSIGNMENTS"], ["Aſſignments"]])("%s is the same name for this purpose (case and Unicode folding)", async (name) => {
    await fs.mkdir(path.join(root, name));
    const result = await run();
    expect(result.assignments?.folder).toBe("Assignments (2)");
  });

  it("an existing Assignments (2) pushes the choice on to (3)", async () => {
    await fs.mkdir(path.join(root, "assignments"));
    await fs.mkdir(path.join(root, "Assignments (2)"));
    const result = await run();
    expect(result.assignments?.folder).toBe("Assignments (3)");
  });

  it("a recorded root is reused as it is, even though a case variant is there, and nothing moves", async () => {
    const first = await run();
    expect(first.assignments?.folder).toBe("Assignments");
    // The student now also has his own lower-case folder (on a case-sensitive disk, a different one).
    try {
      await fs.mkdir(path.join(root, "assignments-notes"));
    } catch {
      // not needed
    }
    const before = (await listTree(root)).filter((e) => !e.endsWith("/"));
    const second = await again();
    expect(second.assignments?.folder).toBe("Assignments");
    expect((await listTree(root)).filter((e) => !e.endsWith("/"))).toEqual(before);
  });

  it("a root recorded in the manifest wins over a pre-existing folder of the same name", async () => {
    await fs.mkdir(path.join(root, "assignments"));
    await fs.writeFile(
      path.join(root, ".brightspace-sync.json"),
      JSON.stringify({ version: 1, courses: {}, extras: { "42": { assignmentsRoot: "Assignments", announcementsRoot: "Announcements", assignments: {}, announcements: {} } } })
    );
    const result = await run();
    expect(result.assignments?.folder).toBe("Assignments");
    expect((await listTree(root)).some((e) => e.endsWith("Essay 2/feedback.md"))).toBe(true);
  });

  it("a dry run reports the name it would use and creates nothing", async () => {
    await fs.mkdir(path.join(root, "assignments"));
    const result = await run({ dryRun: true });
    expect(result.assignments?.folder).toBe("Assignments (2)");
    expect(result.planned).toContain("Assignments (2)/Essay 2/feedback.md");
    expect(await listTree(root)).toEqual(["assignments/"]);
  });

  it("a destination that does not exist yet (dry run) does not crash", async () => {
    const missing = path.join(parent, "not-there-yet");
    const result = await run({ dryRun: true }, missing);
    expect(result.assignments?.folder).toBe("Assignments");
    expect(result.failed).toEqual([]);
  });
});
