import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError, NetworkError } from "../../src/api/errors.js";
import { syncCourse, type SyncOptions } from "../../src/sync/course-sync.js";
import { fakeBrightspace, fileTopic, listTree, module_, pdf, tempRoot, type Fake, type Step } from "./harness.js";

let parent: string;
let root: string;
let fake: Fake | undefined;
const sleeps: number[] = [];

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The destination sits in a private parent so a write that escapes it is visible there.
  parent = await tempRoot();
  root = path.join(parent, "dest");
  await fs.mkdir(root);
  sleeps.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake?.close();
  fake = undefined;
  await fs.rm(parent, { recursive: true, force: true });
});

const ok = (tag = "x", pad = 64): Step => ({ body: pdf(tag, pad) });

async function run(toc: unknown, topics: Record<number, Step | Step[]>, options: Partial<SyncOptions> = {}, extra: Record<string, unknown> = {}) {
  fake = await fakeBrightspace(toc, topics, extra);
  return syncCourse(fake.client, {
    courseId: 42,
    destination: root,
    sleep: async (ms) => { sleeps.push(ms); },
    ...options,
  });
}

const url = (name: string) => `/content/enforced/42-Course/${encodeURIComponent(name)}`;

describe("syncCourse: table of contents mapping", () => {
  const toc = {
    Modules: [
      module_(1, "Week 1", [fileTopic(10, url("Lecture 1.pdf")), fileTopic(11, url("Slides.pdf"))], [
        module_(2, "Readings", [fileTopic(20, url("Paper.pdf"))], [module_(3, "Deep", [fileTopic(30, url("Deep.pdf"))])]),
      ]),
      module_(4, "Week 2", [fileTopic(40, url("Lab.pdf"))]),
    ],
    Topics: [fileTopic(50, url("Syllabus.pdf"))],
  };
  const all = { 10: ok("a"), 11: ok("b"), 20: ok("c"), 30: ok("d"), 40: ok("e"), 50: ok("f") };

  it("makes modules folders, nested modules sub-folders and root topics root files", async () => {
    const result = await run(toc, all);
    expect(await listTree(root)).toEqual([
      "Syllabus.pdf",
      "Week 1/",
      "Week 1/Lecture 1.pdf",
      "Week 1/Readings/",
      "Week 1/Readings/Deep/",
      "Week 1/Readings/Deep/Deep.pdf",
      "Week 1/Readings/Paper.pdf",
      "Week 1/Slides.pdf",
      "Week 2/",
      "Week 2/Lab.pdf",
    ]);
    expect(result.downloaded.map((f) => f.path).sort()).toEqual([
      "Syllabus.pdf",
      "Week 1/Lecture 1.pdf",
      "Week 1/Readings/Deep/Deep.pdf",
      "Week 1/Readings/Paper.pdf",
      "Week 1/Slides.pdf",
      "Week 2/Lab.pdf",
    ]);
    expect(result.downloaded[0].bytes).toBeGreaterThan(0);
    expect(result.destination).toBe(root);
    expect(result.failed).toEqual([]);
    expect(result.notAttempted).toBe(0);
  });

  it("reads the table of contents once", async () => {
    await run(toc, all);
    expect(fake!.tocReads()).toBe(1);
  });

  it("downloads only the chosen module's subtree with moduleId", async () => {
    const result = await run(toc, all, { moduleId: 2 });
    expect(result.downloaded.map((f) => f.path).sort()).toEqual(["Readings/Deep/Deep.pdf", "Readings/Paper.pdf"]);
    expect(fake!.requests.has(10)).toBe(false);
    expect(fake!.requests.has(50)).toBe(false);
  });

  it("rejects a moduleId that is not in the course", async () => {
    await expect(run(toc, all, { moduleId: 999 })).rejects.toThrow(/module 999/i);
  });

  it("names a file after the original upload even when the title differs", async () => {
    const result = await run({ Modules: [module_(1, "M", [fileTopic(10, url("Original Name.pdf"), { Title: "Pretty title" })])] }, { 10: ok() });
    expect(result.downloaded[0].path).toBe("M/Original Name.pdf");
  });

  it("falls back to the title when the Url has no file name", async () => {
    const result = await run({ Modules: [module_(1, "M", [fileTopic(10, "/content/enforced/42-Course/", { Title: "Syllabus" })])] }, { 10: ok() });
    expect(result.downloaded[0].path).toBe("M/Syllabus");
  });

  it("counts links, embedded media, broken items, other types and skips none silently", async () => {
    const tocMixed = {
      Modules: [module_(1, "M", [
        fileTopic(10, url("A.pdf")),
        { TopicId: 11, Title: "Link", TypeIdentifier: "Link", TopicType: 3, Url: "https://example.com" },
        { TopicId: 12, Title: "Video", TypeIdentifier: "ContentService", Url: "/d2l/x" },
        fileTopic(13, null),
        fileTopic(14, url("Gone.pdf"), { IsBroken: true }),
        { TopicId: 15, Title: "Quiz", TypeIdentifier: "Quiz" },
        { TopicId: 16, Title: "Discussion", TypeIdentifier: "Discussion" },
      ])],
    };
    const result = await run(tocMixed, { 10: ok() });
    expect(result.nonFiles).toEqual({ link: 1, media: 1, broken: 2, other: 2, unavailable: 0 });
    expect(result.downloaded).toHaveLength(1);
    expect([...fake!.requests.keys()]).toEqual([10]);
  });
});

describe("syncCourse: names on disk", () => {
  it("sanitises Windows-invalid characters, reserved names and long names", async () => {
    const long = `${"x".repeat(300)}.pdf`;
    const toc = { Modules: [module_(1, "Week 1: Intro?", [
      fileTopic(10, "/content/enforced/42-C/a<b>c.pdf"),
      fileTopic(11, "/content/enforced/42-C/CON.pdf"),
      fileTopic(12, "/content/enforced/42-C/trailing.pdf.."),
      fileTopic(13, `/content/enforced/42-C/${long}`),
    ])] };
    const result = await run(toc, { 10: ok("1"), 11: ok("2"), 12: ok("3"), 13: ok("4") });
    const names = result.downloaded.map((f) => f.path.split("/").pop()!).sort();
    expect(names).toContain("a_b_c.pdf");
    expect(names).toContain("_CON.pdf");
    expect(names).toContain("trailing.pdf");
    const longName = names.find((n) => n.startsWith("xxx"))!;
    expect(longName.length).toBeLessThanOrEqual(150);
    expect(longName.endsWith(".pdf")).toBe(true);
    expect(result.downloaded[0].path.startsWith("Week 1_ Intro_/")).toBe(true);
  });

  it("gives names that differ only by case their own numbers", async () => {
    const toc = { Modules: [module_(1, "M", [
      fileTopic(10, url("Notes.pdf")), fileTopic(11, url("notes.pdf")), fileTopic(12, url("NOTES.PDF")),
    ])] };
    const result = await run(toc, { 10: ok("1"), 11: ok("2"), 12: ok("3") });
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/Notes.pdf", "M/notes (2).pdf", "M/NOTES (3).PDF"]);
  });

  it("reserves module folder names before file names in the same folder", async () => {
    const toc = { Modules: [module_(1, "Parent", [fileTopic(10, "/content/enforced/42-C/Labs")], [module_(2, "labs", [fileTopic(20, url("A.pdf"))])])] };
    const result = await run(toc, { 10: ok("1"), 20: ok("2") });
    const paths = result.downloaded.map((f) => f.path).sort();
    expect(paths).toEqual(["Parent/Labs (2)", "Parent/labs/A.pdf"]);
  });

  it("gives sibling modules with the same title their own folders", async () => {
    const toc = { Modules: [module_(1, "Week", [fileTopic(10, url("A.pdf"))]), module_(2, "WEEK", [fileTopic(20, url("A.pdf"))])] };
    const result = await run(toc, { 10: ok("1"), 20: ok("2") });
    expect(result.downloaded.map((f) => f.path).sort()).toEqual(["WEEK (2)/A.pdf", "Week/A.pdf"]);
  });
});

describe("syncCourse: path traversal", () => {
  /** Anything beside the destination in its parent: a write that got out. */
  const inside = async () => (await fs.readdir(parent)).filter((n) => n !== "dest");

  it.each([
    ["../../x", "x"],
    ["..", ".."],
    [".", "."],
    ["/etc", "etc"],
    ["C:\\Windows\\System32", "System32"],
    ["..\\..\\evil", "evil"],
    ["a/../../b", "b"],
    ["nul\u0000byte", "byte"],
  ])("keeps a module titled %j inside the destination", async (title) => {
    const toc = { Modules: [module_(1, title, [fileTopic(10, url("A.pdf"))])] };
    const result = await run(toc, { 10: ok() });
    expect(result.downloaded).toHaveLength(1);
    const rel = result.downloaded[0].path;
    expect(rel.split("/")).toHaveLength(2);
    const resolved = path.resolve(root, rel);
    expect(resolved.startsWith(path.resolve(root) + path.sep)).toBe(true);
    expect(await inside()).toEqual([]);
    for (const entry of await listTree(root)) expect(entry).not.toMatch(/\u0000/);
  });

  it.each(["../../pwned.pdf", "..%2F..%2Fpwned.pdf", "/etc/passwd.pdf", "..\\..\\pwned.pdf", "a%00b.pdf"])(
    "keeps a file named %j inside the destination",
    async (name) => {
      const toc = { Modules: [module_(1, "M", [fileTopic(10, `/content/enforced/42-C/${name}`)])] };
      const result = await run(toc, { 10: ok() });
      for (const f of result.downloaded) {
        expect(path.resolve(root, f.path).startsWith(path.resolve(root) + path.sep)).toBe(true);
        expect(f.path.split("/")).toHaveLength(2);
      }
      expect(await inside()).toEqual([]);
    },
  );

  it("refuses to follow a symlinked sub-folder out of the destination", async () => {
    const outside = await fs.mkdtemp(path.join(parent, "outside-"));
    try {
      await fs.symlink(outside, path.join(root, "Week 1"), "dir");
      const toc = { Modules: [module_(1, "Week 1", [fileTopic(10, url("A.pdf"))]), module_(2, "Week 2", [fileTopic(20, url("B.pdf"))])] };
      const result = await run(toc, { 10: ok("1"), 20: ok("2") });
      expect(await fs.readdir(outside)).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].path).toBe("Week 1/A.pdf");
      expect(result.failed[0].error).toMatch(/symbolic link/i);
      expect(result.downloaded.map((f) => f.path)).toEqual(["Week 2/B.pdf"]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("does not report a file as already present when its folder is a symlink", async () => {
    const outside = await fs.mkdtemp(path.join(parent, "outside-"));
    try {
      await fs.writeFile(path.join(outside, "A.pdf"), pdf("other"));
      await fs.symlink(outside, path.join(root, "Week 1"), "dir");
      const result = await run({ Modules: [module_(1, "Week 1", [fileTopic(10, url("A.pdf"))])] }, { 10: ok() });
      expect(result.skippedExisting).toBe(0);
      expect(result.failed).toHaveLength(1);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("syncCourse: existing files", () => {
  const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf"))])] };
  const target = () => path.join(root, "M", "A.pdf");
  const seed = async (content: Buffer) => {
    await fs.mkdir(path.join(root, "M"), { recursive: true });
    await fs.writeFile(target(), content);
  };

  it("skips an existing file by default and leaves it untouched", async () => {
    const mine = pdf("my annotations");
    await seed(mine);
    const result = await run(toc, { 10: ok("server copy") });
    expect(result.skippedExisting).toBe(1);
    expect(result.downloaded).toEqual([]);
    expect(await fs.readFile(target())).toEqual(mine);
    expect(fake!.requests.has(10)).toBe(false);
  });

  it("a rerun downloads nothing and creates nothing new", async () => {
    const big = {
      Modules: [module_(1, "W", [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf"))], [module_(2, "Sub", [fileTopic(20, url("C.pdf"))])])],
    };
    const plan = { 10: ok("a"), 11: ok("b"), 20: ok("c") };
    const first = await run(big, plan);
    expect(first.downloaded).toHaveLength(3);
    const before = await listTree(root);
    await fake!.close();
    const second = await run(big, plan);
    expect(second.downloaded).toEqual([]);
    expect(second.skippedExisting).toBe(3);
    expect(fake!.requests.size).toBe(0);
    expect(await listTree(root)).toEqual(before);
  });

  /** A first run leaves the file, and the manifest entry that says the sync wrote it. */
  const firstRun = async (body = pdf("old")) => {
    await run(toc, { 10: { body } });
    await fake!.close();
  };

  it("replaces a file this sync wrote with existing: replace", async () => {
    await firstRun();
    const fresh = pdf("new", 200);
    const result = await run(toc, { 10: { body: fresh } }, { existing: "replace" });
    expect(result.downloaded).toEqual([{ path: "M/A.pdf", bytes: fresh.length }]);
    expect(await fs.readFile(target())).toEqual(fresh);
    expect(await listTree(root)).toEqual(["M/", "M/A.pdf"]);
  });

  it("never replaces the user's own file, which the manifest does not list", async () => {
    const mine = pdf("my own copy");
    await seed(mine);
    const result = await run(toc, { 10: { body: pdf("new", 200) } }, { existing: "replace" });
    expect(result.skippedExisting).toBe(1);
    expect(result.downloaded).toEqual([]);
    expect(await fs.readFile(target())).toEqual(mine);
    expect(fake!.requests.has(10)).toBe(false);
  });

  it("keeps the file when a replace download fails", async () => {
    await firstRun();
    const before = await fs.readFile(target());
    const result = await run(toc, { 10: { status: 403 } }, { existing: "replace" });
    expect(result.failed).toHaveLength(1);
    expect(await fs.readFile(target())).toEqual(before);
  });

  it("saves a differing copy as 'name (1).ext' with existing: keep_both", async () => {
    const mine = pdf("old");
    await seed(mine);
    const fresh = pdf("new", 500);
    const result = await run(toc, { 10: { body: fresh } }, { existing: "keep_both" });
    expect(result.downloaded).toEqual([{ path: "M/A (1).pdf", bytes: fresh.length }]);
    expect(await fs.readFile(target())).toEqual(mine);
    expect(await fs.readFile(path.join(root, "M", "A (1).pdf"))).toEqual(fresh);
  });

  it("does not save a copy when an existing one has the same size (keep_both)", async () => {
    await seed(pdf("old", 100));
    const result = await run(toc, { 10: { body: pdf("new", 100) } }, { existing: "keep_both" });
    expect(result.downloaded).toEqual([]);
    expect(result.skippedExisting).toBe(1);
    expect(await listTree(root)).toEqual(["M/", "M/A.pdf"]);
  });

  it("compares against earlier keep_both copies too, and numbers the next one", async () => {
    await seed(pdf("old", 100));
    await fs.writeFile(path.join(root, "M", "A (1).pdf"), pdf("v2", 300));
    const same = await run(toc, { 10: { body: pdf("v2", 300) } }, { existing: "keep_both" });
    expect(same.skippedExisting).toBe(1);
    await fake!.close();
    const different = await run(toc, { 10: { body: pdf("v3", 700) } }, { existing: "keep_both" });
    expect(different.downloaded[0].path).toBe("M/A (2).pdf");
  });

  it("downloads a missing file under keep_both without a suffix", async () => {
    const result = await run(toc, { 10: ok() }, { existing: "keep_both" });
    expect(result.downloaded[0].path).toBe("M/A.pdf");
  });
});

describe("syncCourse: failures and retries", () => {
  const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf"))])] };

  it.each([408, 425])("retries a transient %i with the 1.5 s then 4 s backoff", async (status) => {
    const result = await run(toc, { 10: [{ status }, { status }, ok("a")], 11: ok("b") });
    expect(result.downloaded).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(sleeps).toEqual([1500, 4000]);
    expect(fake!.requests.get(10)).toBe(3);
  });

  it("gives up after the delays are used and reports the file as failed", async () => {
    const result = await run(toc, { 10: { status: 408 }, 11: ok("b") });
    expect(result.failed).toEqual([{ path: "M/A.pdf", error: expect.stringMatching(/408/) }]);
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/B.pdf"]);
    expect(fake!.requests.get(10)).toBe(3);
    expect(await listTree(root)).toEqual(["M/", "M/B.pdf"]);
  });

  it.each([429, 500, 502, 503, 504])("does not retry a %i itself: the API client already did", async (status) => {
    const result = await run(toc, { 10: { status }, 11: ok("b") });
    expect(result.failed).toHaveLength(1);
    expect(fake!.requests.get(10)).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry a network error itself either", async () => {
    const result = await run(toc, { 10: { error: new NetworkError("socket hang up") }, 11: ok("b") });
    expect(result.failed).toEqual([{ path: "M/A.pdf", error: "Could not connect to Brightspace" }]);
    expect(fake!.requests.get(10)).toBe(1);
  });

  it("makes at most three requests for one file however it fails", async () => {
    for (const step of [{ status: 408 }, { short: true, body: pdf("cut", 1000) }] as Step[]) {
      await run(toc, { 10: step, 11: ok("b") });
      expect(fake!.requests.get(10)).toBe(3);
      await fake!.close();
    }
  });

  it("does not retry a 404 or 403", async () => {
    const result = await run(toc, { 10: { status: 404 }, 11: { status: 403 } });
    expect(result.failed).toHaveLength(2);
    expect(fake!.requests.get(10)).toBe(1);
    expect(fake!.requests.get(11)).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("fails a body that ends short of its Content-Length, retries it, and leaves no file", async () => {
    const result = await run(toc, { 10: { short: true, body: pdf("cut", 1000) }, 11: ok("b") });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe("M/A.pdf");
    expect(result.failed[0].error).toMatch(/incomplete/i);
    expect(fake!.requests.get(10)).toBe(3);
    expect(await listTree(root)).toEqual(["M/", "M/B.pdf"]);
  });

  it("succeeds when a short body is followed by a whole one", async () => {
    const result = await run(toc, { 10: [{ short: true, body: pdf("cut", 1000) }, ok("a")], 11: ok("b") });
    expect(result.downloaded).toHaveLength(2);
    expect(await listTree(root)).toEqual(["M/", "M/A.pdf", "M/B.pdf"]);
  });

  it("reports a file the type check refuses as failed and carries on", async () => {
    const result = await run(toc, { 10: { body: Buffer.from([0, 1, 2, 3, 0, 0, 9, 9]) }, 11: ok("b") });
    expect(result.failed).toHaveLength(1);
    expect(result.downloaded).toHaveLength(1);
  });
});

describe("syncCourse: expired session", () => {
  const toc = { Modules: [module_(1, "M", [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf")), fileTopic(12, url("C.pdf")), fileTopic(13, url("D.pdf"))])] };

  it("stops at a 401 mid-run, gives the sign-in guidance and reports the rest as not attempted", async () => {
    const result = await run(toc, { 10: ok("a"), 11: { status: 401 }, 12: ok("c"), 13: ok("d") });
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/A.pdf"]);
    expect(result.failed).toEqual([]);
    expect(result.notAttempted).toBe(3);
    expect(result.authError).toMatch(/auth/i);
    expect(fake!.requests.has(12)).toBe(false);
    expect(fake!.requests.has(13)).toBe(false);
    expect(fake!.requests.get(11)).toBe(1);
  });

  it("stops when the rejected credential is a pasted one", async () => {
    const { CredentialRejectedError } = await import("../../src/api/errors.js");
    const result = await run(toc, { 10: { error: new CredentialRejectedError("/x", "Paste a fresh D2L_SESSION_COOKIE.") } });
    expect(result.authError).toBe("Paste a fresh D2L_SESSION_COOKIE.");
    expect(result.notAttempted).toBe(4);
  });

  it("does not stop on a 403, which is one file's refusal", async () => {
    const result = await run(toc, { 10: { status: 403 }, 11: ok("b"), 12: ok("c"), 13: ok("d") });
    expect(result.authError).toBeUndefined();
    expect(result.failed).toHaveLength(1);
    expect(result.downloaded).toHaveLength(3);
  });

  it("stops before downloading anything when the table of contents needs sign-in", async () => {
    fake = await fakeBrightspace(toc, {});
    fake.client.get.mockRejectedValue(new ApiError(401, "/toc", "expired"));
    const result = await syncCourse(fake.client, { courseId: 42, destination: root });
    expect(result.authError).toMatch(/auth/i);
    expect(result.downloaded).toEqual([]);
  });
});

describe("syncCourse: unavailable topics", () => {
  const toc = { Modules: [module_(1, "M", [
    fileTopic(10, url("A.pdf")),
    fileTopic(11, url("Locked.pdf"), { IsLocked: true }),
    fileTopic(12, url("Future.pdf"), { StartDateTime: "2099-01-01T00:00:00Z" }),
  ])] };

  it("counts locked and not-yet-open topics as unavailable, not failed", async () => {
    const result = await run(toc, { 10: ok("a"), 11: { status: 403 }, 12: { status: 404 } });
    expect(result.nonFiles.unavailable).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.downloaded.map((f) => f.path)).toEqual(["M/A.pdf"]);
    expect(result.notAttempted).toBe(0);
  });

  it("keeps a 403 that the metadata does not explain as a failure", async () => {
    const result = await run({ Modules: [module_(1, "M", [fileTopic(10, url("A.pdf"))])] }, { 10: { status: 403 } });
    expect(result.nonFiles.unavailable).toBe(0);
    expect(result.failed).toHaveLength(1);
  });
});

describe("syncCourse: dry run and cap", () => {
  const toc = { Modules: [
    module_(1, "Week 1", [fileTopic(10, url("A.pdf")), fileTopic(11, url("B.pdf"))]),
    module_(2, "Week 2", [fileTopic(20, url("C.pdf")), fileTopic(21, url("D.pdf"))]),
  ] };
  const plan = { 10: ok("a"), 11: ok("b"), 20: ok("c"), 21: ok("d") };

  it("lists planned files and downloads nothing, creating no folders", async () => {
    const result = await run(toc, plan, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.planned).toEqual(["Week 1/A.pdf", "Week 1/B.pdf", "Week 2/C.pdf", "Week 2/D.pdf"]);
    expect(result.downloaded).toEqual([]);
    expect(fake!.requests.size).toBe(0);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("a dry run leaves out what is already on disk", async () => {
    await fs.mkdir(path.join(root, "Week 1"));
    await fs.writeFile(path.join(root, "Week 1", "A.pdf"), pdf());
    const result = await run(toc, plan, { dryRun: true });
    expect(result.skippedExisting).toBe(1);
    expect(result.planned).toEqual(["Week 1/B.pdf", "Week 2/C.pdf", "Week 2/D.pdf"]);
  });

  it("stops at maxFiles and reports the rest as not attempted", async () => {
    const result = await run(toc, plan, { maxFiles: 3 });
    expect(result.downloaded).toHaveLength(3);
    expect(result.notAttempted).toBe(1);
    expect(fake!.requests.has(21)).toBe(false);
  });

  it("does not count files already on disk against maxFiles, so a rerun makes progress", async () => {
    await run(toc, plan, { maxFiles: 3 });
    await fake!.close();
    const second = await run(toc, plan, { maxFiles: 3 });
    expect(second.skippedExisting).toBe(3);
    expect(second.downloaded.map((f) => f.path)).toEqual(["Week 2/D.pdf"]);
    expect(second.notAttempted).toBe(0);
  });

  it("applies the cap to a dry run too", async () => {
    const result = await run(toc, plan, { dryRun: true, maxFiles: 2 });
    expect(result.planned).toHaveLength(2);
    expect(result.notAttempted).toBe(2);
  });

  it("defaults the cap to 300 files", async () => {
    const many = { Modules: [module_(1, "M", Array.from({ length: 305 }, (_, i) => fileTopic(1000 + i, url(`f${i}.pdf`))))] };
    const result = await run(many, {}, { dryRun: true });
    expect(result.planned).toHaveLength(300);
    expect(result.notAttempted).toBe(5);
  });
});

describe("syncCourse: bad tables of contents", () => {
  it("handles a course with no content", async () => {
    const result = await run({ Modules: [] }, {});
    expect(result.downloaded).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each([null, {}, { Modules: "nope" }, { Modules: [null, 5, { Topics: "x" }] }])("tolerates a malformed table of contents: %j", async (toc) => {
    const result = await run(toc, {});
    expect(result.downloaded).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("rejects a destination that does not exist", async () => {
    fake = await fakeBrightspace({ Modules: [] }, {});
    await expect(syncCourse(fake.client, { courseId: 42, destination: path.join(root, "missing") })).rejects.toThrow(/does not exist/i);
  });
});
