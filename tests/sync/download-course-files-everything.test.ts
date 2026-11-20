import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { registerDownloadCourseFiles } from "../../src/tools/download-course-files.js";
import { DownloadCourseFilesSchema } from "../../src/tools/schemas.js";
import { CONTENT_ONLY_SCOPE } from "../../src/sync/summary.js";
import { listTree, pdf, tempRoot, type Fake } from "./harness.js";
import { fakeCourse, folder, news, route, status, submission, type Extras } from "./extras-harness.js";

let dir: string;
let fake: (Fake & { rawRequests: string[] }) | undefined;

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await tempRoot();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake?.close();
  fake = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const routes = (): Extras["routes"] => ({
  [route("/dropbox/folders/")]: [folder(5, "Essay 2", { Attachments: [{ FileId: 21, FileName: "Prompt.pdf", Size: 10 }] })],
  [route("/dropbox/folders/5/submissions/mysubmissions/")]: [submission(3, [{ FileId: 11, FileName: "Essay.docx" }])],
  [route("/dropbox/folders/5/feedback/myFeedback/")]: { IsGraded: true, Score: 18, Feedback: { Text: "Good.", Html: "" } },
  [route("/news/")]: [news(8, "Slides", [{ FileId: 41, FileName: "Slides.pdf" }])],
});
const files = (): Extras["files"] => ({
  [route("/dropbox/folders/5/submissions/3/files/11")]: { body: pdf("s") },
  [route("/dropbox/folders/5/attachments/21")]: { body: pdf("p") },
  [route("/news/8/attachments/41")]: { body: pdf("n") },
});

async function register(extraRoutes: Extras["routes"] = routes()) {
  fake = await fakeCourse({ Modules: [], Topics: [] }, {}, { routes: extraRoutes, files: files() });
  let config: any;
  let handler: any;
  registerDownloadCourseFiles({ registerTool: (_n: string, c: unknown, f: any) => { config = c; handler = f; } } as never, fake.client as never);
  return { config, call: async (args: Record<string, unknown>) => (await handler({ courseId: 42, downloadPath: dir, ...args })).content[0].text as string };
}
const readPaths = () => fake!.client.get.mock.calls.map((c: unknown[]) => String(c[0]));

describe("download_course_files: pulling more than Content", () => {
  it("defaults every new option and everything to false", () => {
    const parsed = DownloadCourseFilesSchema.parse({ courseId: 42, downloadPath: "/x" });
    expect(parsed).toMatchObject({ includeSubmissions: false, includeAssignmentFiles: false, includeAnnouncementFiles: false, everything: false });
  });

  it("with every option off, reads no assignment or announcement route and says it covered Content only", async () => {
    const { call } = await register();
    const text = await call({});
    expect(readPaths().some((p) => p.includes("/dropbox/") || p.includes("/news/"))).toBe(false);
    expect(text.split("\n").at(-1)).toBe(CONTENT_ONLY_SCOPE);
    expect(await listTree(dir)).toEqual([]);
  });

  it("everything: true turns on every include option", async () => {
    const { call } = await register();
    const text = await call({ everything: true });
    expect(await listTree(dir)).toEqual([
      "Announcements/",
      "Announcements/2026-10-01 Slides/",
      "Announcements/2026-10-01 Slides/Slides.pdf",
      "Assignments/",
      "Assignments/Essay 2/",
      "Assignments/Essay 2/assignment files/",
      "Assignments/Essay 2/assignment files/Prompt.pdf",
      "Assignments/Essay 2/feedback.md",
      "Assignments/Essay 2/my files/",
      "Assignments/Essay 2/my files/Essay.docx",
    ]);
    expect(text).toContain("Assignments: 1 assignment read");
    expect(text).toContain("Announcements: 1 announcement read");
    expect(text).toMatch(/It did not look at: the syllabus \(get_syllabus\)\.$/);
  });

  it.each([
    ["includeSubmissions", ["Assignments/Essay 2/feedback.md", "Assignments/Essay 2/my files/Essay.docx"]],
    ["includeAssignmentFiles", ["Assignments/Essay 2/assignment files/Prompt.pdf"]],
    ["includeAnnouncementFiles", ["Announcements/2026-10-01 Slides/Slides.pdf"]],
  ])("%s alone saves only its own files", async (option, expected) => {
    const { call } = await register();
    await call({ [option]: true });
    expect((await listTree(dir)).filter((e) => !e.endsWith("/"))).toEqual(expected);
  });

  it("says an unreadable thing is unknown, in words an agent must relay", async () => {
    const broken = routes();
    broken[route("/dropbox/folders/5/submissions/mysubmissions/")] = status(403);
    const { call } = await register(broken);
    const text = await call({ everything: true });
    expect(text).toContain("Not fully saved");
    expect(text).toContain('assignment "Essay 2": submissions: Brightspace refused the request: 403');
    expect(await fs.readFile(path.join(dir, "Assignments", "Essay 2", "feedback.md"), "utf8")).toContain("- Submitted: unknown (");
  });

  it("describes the options, the layout, the refresh and the unknown rule to the agent", async () => {
    const { config } = await register();
    const d: string = config.description;
    for (const word of ["everything", "includeSubmissions", "includeAssignmentFiles", "includeAnnouncementFiles", "feedback.md", "Assignments/", "Announcements/", "unknown", "get_syllabus"]) {
      expect(d).toContain(word);
    }
    expect(d).toMatch(/saved when Brightspace lists them/);
    expect(d).toContain("Content area only");
  });

  it("is consistent: it never tells the agent to fetch the extras with other tools after telling it to set everything", async () => {
    const { config } = await register();
    const d: string = config.description;
    expect(d).not.toMatch(/also fetch those with the tools named/);
    // The only tool named for something still not covered is the syllabus one; the others are named only as what the default leaves out.
    expect(d).toMatch(/everything: true[^.]*\./);
    expect(d).toMatch(/syllabus[^.]*never saved|never saves the syllabus|syllabus is not (saved|included)/i);
    expect(d).toMatch(/lists only what/);
    expect(d).toMatch(/stopped|stops/);
    expect(d).toMatch(/call it again|run it again|call again/i);
    expect(d).toMatch(/never report it as none|never report (them|it) as/);
    expect(d.length).toBeLessThan(3800);
  });

  it("says how feedback.md behaves in each existing mode", async () => {
    const { config } = await register();
    const d: string = config.description;
    expect(d).toContain("feedback (2).md");
    expect(d).toMatch(/skip and replace leave/);
  });
});
