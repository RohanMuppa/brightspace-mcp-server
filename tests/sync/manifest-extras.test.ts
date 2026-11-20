import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MANIFEST_NAME, SyncManifest } from "../../src/sync/manifest.js";

const HASH = "a".repeat(64);
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-extras-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, MANIFEST_NAME);
const readJson = async () => JSON.parse(await fs.readFile(file(), "utf8"));
const writeJson = (value: unknown) => fs.writeFile(file(), JSON.stringify(value));

/** A manifest with the extras roots for course 42 set, as the sync does before it records anything. */
async function withRoots(): Promise<SyncManifest> {
  const manifest = await SyncManifest.load(dir);
  manifest.setExtrasRoot(42, "assignments", "Assignments");
  manifest.setExtrasRoot(42, "announcements", "Announcements");
  return manifest;
}

describe("SyncManifest extras", () => {
  it("round-trips the roots and the assignment and announcement records next to courses", async () => {
    const manifest = await withRoots();
    manifest.set(42, 10, { path: "Week 1/A.pdf", bytes: 7 });
    manifest.set(43, 10, { path: "Other/A.pdf", bytes: 8 });
    const a = manifest.assignment(42, 5);
    a.dir = "Assignments/Essay";
    a.feedback = { path: "Assignments/Essay/feedback.md", size: 9, mtimeMs: 1000.5, hash: HASH };
    a.files["sub:3:11"] = { path: "Assignments/Essay/my files/Essay.docx", bytes: 5, size: 5, mtimeMs: 2 };
    manifest.announcement(42, 8).dir = "Announcements/2026-10-01 Hello";
    manifest.announcement(42, 8).files["77"] = { path: "Announcements/2026-10-01 Hello/Slides.pdf", bytes: 1 };
    manifest.touch();
    await manifest.save();

    const again = await SyncManifest.load(dir);
    expect(again.get(42, 10)).toEqual({ path: "Week 1/A.pdf", bytes: 7 });
    expect(again.extrasRoot(42, "assignments")).toBe("Assignments");
    expect(again.extrasRoot(42, "announcements")).toBe("Announcements");
    expect(again.extrasRoot(43, "assignments")).toBeUndefined();
    expect(again.findAssignment(42, 5)).toEqual({
      dir: "Assignments/Essay",
      feedback: { path: "Assignments/Essay/feedback.md", size: 9, mtimeMs: 1000.5, hash: HASH },
      files: { "sub:3:11": { path: "Assignments/Essay/my files/Essay.docx", bytes: 5, size: 5, mtimeMs: 2 } },
    });
    expect(again.findAnnouncement(42, 8)?.files["77"].path).toBe("Announcements/2026-10-01 Hello/Slides.pdf");
    expect(again.findAssignment(42, 6)).toBeUndefined();
    expect(again.findAssignment(43, 5)).toBeUndefined();
  });

  it("writes no extras key when there are none, so a Content-only manifest stays byte-for-byte the same", async () => {
    const manifest = await SyncManifest.load(dir);
    manifest.set(42, 10, { path: "a.pdf", bytes: 1 });
    await manifest.save();
    expect(Object.keys(await readJson()).sort()).toEqual(["courses", "version"]);
  });

  it("never lets extras change what Content entries() or ownerOf see", async () => {
    const manifest = await withRoots();
    manifest.set(42, 10, { path: "Week 1/A.pdf", bytes: 7 });
    manifest.assignment(42, 5).files["asg:1"] = { path: "Assignments/X/assignment files/P.pdf", bytes: 1 };
    manifest.touch();
    expect(manifest.entries(42)).toEqual([[10, { path: "Week 1/A.pdf", bytes: 7 }]]);
    expect(manifest.ownerOf(42, "Assignments/X/assignment files/P.pdf")).toBeUndefined();
  });

  it("loads an old-format manifest (courses only) with no extras", async () => {
    await writeJson({ version: 1, courses: { 42: { 10: { path: "a.pdf", bytes: 1 } } } });
    const manifest = await SyncManifest.load(dir);
    expect(manifest.unreadable).toBeUndefined();
    expect(manifest.get(42, 10)?.path).toBe("a.pdf");
    expect(manifest.findAssignment(42, 1)).toBeUndefined();
  });

  const record = (over: Record<string, unknown> = {}) => ({
    version: 1,
    courses: {},
    extras: {
      "42": {
        assignmentsRoot: "Assignments",
        announcementsRoot: "Announcements",
        assignments: {
          "5": {
            dir: "Assignments/Ok",
            feedback: { path: "Assignments/Ok/feedback.md", size: 1, mtimeMs: 1, hash: HASH },
            files: { "sub:3:11": { path: "Assignments/Ok/my files/a.pdf", bytes: 1 } },
          },
        },
        announcements: {},
        ...over,
      },
    },
  });

  it("ignores bad ids, bad file keys and bad paths", async () => {
    const good = record();
    const course = good.extras["42"] as any;
    course.assignments["x1"] = { dir: "Assignments/Bad", files: {} };
    course.assignments["6"] = { dir: "../out", files: { "sub:1:1": { path: "Assignments/g.pdf", bytes: 1 } } };
    Object.assign(course.assignments["5"].files, {
      "__proto__": { path: "Assignments/Ok/b.pdf", bytes: 1 },
      "sub:3:12": { path: "/abs/c.pdf", bytes: 1 },
      "sub:3:13": { path: "Assignments/Ok/../d.pdf", bytes: 1 },
      "sub:3:14": { path: "Assignments\\Ok\\e.pdf", bytes: 1 },
      "bad key": { path: "Assignments/Ok/f.pdf", bytes: 1 },
    });
    (good.extras as any)["__proto__"] = { assignments: { "1": { dir: "Assignments/X", files: {} } } };
    (good.extras as any).constructor = { assignments: {} };
    await writeJson(good);
    const manifest = await SyncManifest.load(dir);
    expect(Object.keys(manifest.findAssignment(42, 5)!.files)).toEqual(["sub:3:11"]);
    expect(manifest.findAssignment(42, 6)).toBeUndefined();
    expect(manifest.findAssignment(Number("__proto__"), 1)).toBeUndefined();
    expect(({} as Record<string, unknown>).assignments).toBeUndefined();
  });

  it("rejects a record that is not under the recorded root for its kind", async () => {
    const bad = record();
    const course = bad.extras["42"] as any;
    course.assignments["7"] = { dir: "Elsewhere/Essay", files: {} };
    course.assignments["8"] = { dir: "Assignments/Deep/er", files: {} };
    course.assignments["9"] = { dir: "Assignments", files: {} };
    course.assignments["10"] = { dir: "Announcements/Essay", files: {} };
    course.assignments["11"] = { dir: "Assignments/Ok2", files: { "asg:1": { path: "Content/Week 1/Notes.pdf", bytes: 1 } }, feedback: { path: "Week 1/feedback.md", size: 1, mtimeMs: 1, hash: HASH } };
    course.announcements["8"] = { dir: "Assignments/Wrong", files: {} };
    await writeJson(bad);
    const manifest = await SyncManifest.load(dir);
    for (const id of [7, 8, 9, 10]) expect(manifest.findAssignment(42, id)).toBeUndefined();
    expect(manifest.findAnnouncement(42, 8)).toBeUndefined();
    // A record under the root keeps only the paths inside its own folder.
    expect(manifest.findAssignment(42, 11)).toEqual({ dir: "Assignments/Ok2", files: {} });
    expect(manifest.findAssignment(42, 5)).toBeDefined();
  });

  it("rejects every record when the course has no recorded root, or the root is not one folder name", async () => {
    for (const roots of [{ assignmentsRoot: undefined }, { assignmentsRoot: "A/B" }, { assignmentsRoot: ".." }, { assignmentsRoot: "" }, { assignmentsRoot: 5 }, { assignmentsRoot: "back\\slash" }]) {
      await writeJson(record(roots));
      const manifest = await SyncManifest.load(dir);
      expect(manifest.findAssignment(42, 5)).toBeUndefined();
      expect(manifest.extrasRoot(42, "assignments")).toBeUndefined();
    }
  });

  it.each([
    ["a string", "oops"],
    ["null", null],
    ["an array", []],
    ["a number", 5],
    ["course records of the wrong type", { "42": "x", "43": [], "44": null, "45": 7 }],
    ["lists of the wrong type", { "42": { assignmentsRoot: "Assignments", assignments: [], announcements: "no" } }],
    ["records of the wrong type", { "42": { assignmentsRoot: "Assignments", assignments: { "5": "x", "6": null, "7": [], "8": { dir: 5 } } } }],
    ["files of the wrong type", { "42": { assignmentsRoot: "Assignments", assignments: { "5": { dir: "Assignments/A", files: [] } } } }],
    ["entries of the wrong type", { "42": { assignmentsRoot: "Assignments", assignments: { "5": { dir: "Assignments/A", files: { "asg:1": { path: 5, bytes: "x" }, "asg:2": null } } } } }],
  ])("reads %s as extras that hold nothing, and the Content entries still load", async (_label, extras) => {
    await writeJson({ version: 1, courses: { "42": { "10": { path: "a.pdf", bytes: 1 } } }, extras });
    const manifest = await SyncManifest.load(dir);
    expect(manifest.get(42, 10)?.path).toBe("a.pdf");
    expect(manifest.unreadable).toBeUndefined();
    for (const id of [5, 6, 7, 8]) {
      const found = manifest.findAssignment(42, id);
      expect(found === undefined || Object.keys(found.files).length === 0).toBe(true);
    }
    // And a save writes a manifest that loads again.
    manifest.set(42, 11, { path: "b.pdf", bytes: 2 });
    await manifest.save();
    expect((await SyncManifest.load(dir)).get(42, 11)?.path).toBe("b.pdf");
  });

  it("an older server that rewrites the manifest drops extras, and a later load reads them as empty", async () => {
    const manifest = await withRoots();
    manifest.assignment(42, 5).dir = "Assignments/X";
    manifest.assignment(42, 5).files["sub:3:11"] = { path: "Assignments/X/my files/a.pdf", bytes: 1 };
    manifest.touch();
    await manifest.save();
    const parsed = await readJson();
    // What a 5.2.19 server writes: only version and courses.
    await writeJson({ version: parsed.version, courses: parsed.courses });
    const later = await SyncManifest.load(dir);
    expect(later.unreadable).toBeUndefined();
    expect(later.findAssignment(42, 5)).toBeUndefined();
    expect(later.extrasRoot(42, "assignments")).toBeUndefined();
  });

  it("keeps the extras of other courses when one course writes", async () => {
    const first = await SyncManifest.load(dir);
    first.setExtrasRoot(42, "assignments", "Assignments");
    first.assignment(42, 5).dir = "Assignments/X";
    first.assignment(42, 5).files["asg:1"] = { path: "Assignments/X/assignment files/a.pdf", bytes: 1 };
    first.touch();
    await first.save();
    const second = await SyncManifest.load(dir);
    second.setExtrasRoot(43, "assignments", "Assignments (2)");
    second.assignment(43, 6).dir = "Assignments (2)/Y";
    second.assignment(43, 6).files["asg:2"] = { path: "Assignments (2)/Y/assignment files/b.pdf", bytes: 1 };
    second.touch();
    await second.save();
    const third = await SyncManifest.load(dir);
    expect(third.findAssignment(42, 5)).toBeDefined();
    expect(third.findAssignment(43, 6)).toBeDefined();
    expect(third.extrasRoot(43, "assignments")).toBe("Assignments (2)");
  });
});
