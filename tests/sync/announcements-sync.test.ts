import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { syncCourse, type SyncOptions, type SyncResult } from "../../src/sync/course-sync.js";
import { SyncManifest } from "../../src/sync/manifest.js";
import { listTree, pdf, tempRoot, type Fake, type Step } from "./harness.js";
import { fakeCourse, news, route, status, type Extras } from "./extras-harness.js";

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
const NEWS = route("/news/");
const attachment = (newsId: number, fileId: number) => route(`/news/${newsId}/attachments/${fileId}`);

async function run(routes: Record<string, unknown>, files: Record<string, Step | Step[]>, options: Partial<SyncOptions> = {}): Promise<SyncResult> {
  extras.routes = { ...routes };
  extras.files = { ...files };
  fake = await fakeCourse({ Modules: [], Topics: [] }, {}, extras);
  return syncCourse(fake.client, { courseId: 42, destination: root, sleep: async () => {}, retryDelaysMs: [], includeAnnouncementFiles: true, ...options });
}

describe("full course pull: announcement attachments", () => {
  it("saves each announcement's attachments under a dated folder and records them", async () => {
    const result = await run(
      { [NEWS]: [news(8, "Week 1 slides", [{ FileId: 41, FileName: "Slides.pdf" }, { FileId: 42, FileName: "Notes.pdf" }]), news(9, "No files", [])] },
      { [attachment(8, 41)]: ok("a"), [attachment(8, 42)]: ok("b") }
    );
    expect(await listTree(root)).toEqual([
      "Announcements/",
      "Announcements/2026-10-01 Week 1 slides/",
      "Announcements/2026-10-01 Week 1 slides/Notes.pdf",
      "Announcements/2026-10-01 Week 1 slides/Slides.pdf",
    ]);
    expect(result.announcements).toMatchObject({ read: 2, withFiles: 1, filesDownloaded: 2, unknown: [] });
    expect(result.assignments).toBeUndefined();
    const record = (await SyncManifest.load(root)).findAnnouncement(42, 8)!;
    expect(record.dir).toBe("Announcements/2026-10-01 Week 1 slides");
    expect(Object.keys(record.files).sort()).toEqual(["41", "42"]);
  });

  it("skips drafts and does not look for files on them", async () => {
    const result = await run({ [NEWS]: [news(8, "Draft", [{ FileId: 41, FileName: "A.pdf" }], { IsPublished: false })] }, { [attachment(8, 41)]: ok() });
    expect(result.announcements).toMatchObject({ read: 0, withFiles: 0 });
    expect(await listTree(root)).toEqual([]);
  });

  it("reports an unreadable list, and never says there are no announcements", async () => {
    const result = await run({ [NEWS]: status(403) }, {});
    expect(result.announcements?.listUnreadable).toContain("403");
    expect(result.announcements?.read).toBe(0);
  });

  it("treats a 404 list as a course without announcements", async () => {
    const result = await run({ [NEWS]: status(404) }, {});
    expect(result.announcements?.listUnreadable).toBeUndefined();
  });

  it("an announcement whose attachment list is unreadable is unknown, not 'no files'", async () => {
    const result = await run({ [NEWS]: [news(8, "Odd", [], { Attachments: "oops" })] }, {});
    expect(result.announcements?.unknown).toEqual([expect.objectContaining({ newsId: 8, title: "Odd" })]);
    expect(result.announcements?.withFiles).toBe(0);
  });

  it("one attachment refused fails by name and the others are saved", async () => {
    const result = await run(
      { [NEWS]: [news(8, "Slides", [{ FileId: 41, FileName: "A.pdf" }, { FileId: 42, FileName: "B.pdf" }])] },
      { [attachment(8, 41)]: { status: 404 }, [attachment(8, 42)]: ok() }
    );
    expect(result.failed).toEqual([{ path: "Announcements/2026-10-01 Slides/A.pdf", error: expect.stringContaining("404") }]);
    expect(result.announcements?.filesDownloaded).toBe(1);
  });

  it("uses the creation date when an announcement was never scheduled, and 'undated' when it has neither", async () => {
    await run(
      { [NEWS]: [news(8, "Created", [{ FileId: 41, FileName: "A.pdf" }], { StartDate: null }), news(9, "Nothing", [{ FileId: 42, FileName: "B.pdf" }], { StartDate: null, CreatedDate: null })] },
      { [attachment(8, 41)]: ok("a"), [attachment(9, 42)]: ok("b") }
    );
    const tree = await listTree(root);
    expect(tree).toContain("Announcements/2026-09-30 Created/A.pdf");
    expect(tree).toContain("Announcements/undated Nothing/B.pdf");
  });

  it("makes hostile titles safe and keeps same-named announcements apart", async () => {
    await run(
      {
        [NEWS]: [
          news(1, "../x", [{ FileId: 1, FileName: "../../evil.pdf" }]),
          news(2, "Same", [{ FileId: 2, FileName: "a.pdf" }]),
          news(3, "Same", [{ FileId: 3, FileName: "a.pdf" }]),
        ],
      },
      { [attachment(1, 1)]: ok("1"), [attachment(2, 2)]: ok("2"), [attachment(3, 3)]: ok("3") }
    );
    const tree = await listTree(root);
    expect(tree.filter((e) => e.endsWith(".pdf"))).toHaveLength(3);
    expect(tree).toContain("Announcements/2026-10-01 Same/a.pdf");
    expect(tree).toContain("Announcements/2026-10-01 Same (2)/a.pdf");
    expect(await fs.readdir(parent)).toEqual(["dest"]);
    for (const entry of tree) expect(entry.split("/").every((part) => !part.startsWith("."))).toBe(true);
  });

  it("a rerun skips what is saved, and a dry run writes nothing", async () => {
    const routes = { [NEWS]: [news(8, "Slides", [{ FileId: 41, FileName: "A.pdf" }])] };
    const files = { [attachment(8, 41)]: ok() };
    await run(routes, files);
    const second = await syncCourse(fake!.client, { courseId: 42, destination: root, sleep: async () => {}, includeAnnouncementFiles: true });
    expect(second.downloaded).toEqual([]);
    expect(second.skippedExisting).toBe(1);
    await fs.rm(root, { recursive: true });
    await fs.mkdir(root);
    const dry = await syncCourse(fake!.client, { courseId: 42, destination: root, sleep: async () => {}, includeAnnouncementFiles: true, dryRun: true });
    expect(dry.planned).toEqual(["Announcements/2026-10-01 Slides/A.pdf"]);
    expect(await listTree(root)).toEqual([]);
  });

  it("a cancel leaves the remaining announcements not reached", async () => {
    const controller = new AbortController();
    const result = await run(
      { [NEWS]: [news(8, "One", [{ FileId: 41, FileName: "A.pdf" }]), news(9, "Two", [{ FileId: 42, FileName: "B.pdf" }])] },
      { [attachment(8, 41)]: ok("a"), [attachment(9, 42)]: ok("b") },
      { signal: controller.signal, onProgress: (event) => { if (event.type === "downloaded") controller.abort(); } }
    );
    expect(result.stopped).toBe("cancelled");
    expect(result.announcements?.filesDownloaded).toBe(1);
    expect(result.announcements?.notReached).toBe(1);
  });

  it("with the option off, never reads the announcement routes", async () => {
    const result = await run({ [NEWS]: [news(8, "Slides", [{ FileId: 41, FileName: "A.pdf" }])] }, {}, { includeAnnouncementFiles: false });
    expect(result.announcements).toBeUndefined();
    expect(fake!.client.get.mock.calls.some((c: unknown[]) => String(c[0]).includes("/news/"))).toBe(false);
  });
});
