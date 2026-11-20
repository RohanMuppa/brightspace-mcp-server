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

const file = (p: string) => path.join(dir, MANIFEST_NAME);
const readJson = async () => JSON.parse(await fs.readFile(file(MANIFEST_NAME), "utf8"));

describe("SyncManifest extras", () => {
  it("round-trips assignment and announcement records next to courses", async () => {
    const manifest = await SyncManifest.load(dir);
    manifest.set(42, 10, { path: "Week 1/A.pdf", bytes: 7 });
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
    expect(again.findAssignment(42, 5)).toEqual({
      dir: "Assignments/Essay",
      feedback: { path: "Assignments/Essay/feedback.md", size: 9, mtimeMs: 1000.5, hash: HASH },
      files: { "sub:3:11": { path: "Assignments/Essay/my files/Essay.docx", bytes: 5, size: 5, mtimeMs: 2 } },
    });
    expect(again.findAnnouncement(42, 8)?.files["77"].path).toBe("Announcements/2026-10-01 Hello/Slides.pdf");
    expect(again.findAssignment(42, 6)).toBeUndefined();
    expect(again.findAssignment(43, 5)).toBeUndefined();
  });

  it("writes no extras key when there are none, so an older manifest stays byte-for-byte the same", async () => {
    const manifest = await SyncManifest.load(dir);
    manifest.set(42, 10, { path: "a.pdf", bytes: 1 });
    await manifest.save();
    expect(Object.keys(await readJson()).sort()).toEqual(["courses", "version"]);
  });

  it("never lets extras change what Content entries() or ownerOf see", async () => {
    const manifest = await SyncManifest.load(dir);
    manifest.set(42, 10, { path: "Week 1/A.pdf", bytes: 7 });
    manifest.assignment(42, 5).files["asg:1"] = { path: "Assignments/X/assignment files/P.pdf", bytes: 1 };
    manifest.touch();
    expect(manifest.entries(42)).toEqual([[10, { path: "Week 1/A.pdf", bytes: 7 }]]);
    expect(manifest.ownerOf(42, "Assignments/X/assignment files/P.pdf")).toBeUndefined();
  });

  it("loads an old-format manifest (courses only) with no extras", async () => {
    await fs.writeFile(file(MANIFEST_NAME), JSON.stringify({ version: 1, courses: { 42: { 10: { path: "a.pdf", bytes: 1 } } } }));
    const manifest = await SyncManifest.load(dir);
    expect(manifest.unreadable).toBeUndefined();
    expect(manifest.get(42, 10)?.path).toBe("a.pdf");
    expect(manifest.findAssignment(42, 1)).toBeUndefined();
  });

  it("ignores bad ids, bad file keys and bad paths", async () => {
    await fs.writeFile(
      file(MANIFEST_NAME),
      JSON.stringify({
        version: 1,
        courses: {},
        extras: {
          "__proto__": { assignments: { 1: { dir: "Assignments/X", files: {} } } },
          constructor: { assignments: {} },
          "42": {
            assignments: {
              "x1": { dir: "Assignments/Bad", files: {} },
              "5": {
                dir: "Assignments/Ok",
                feedback: { path: "../escape.md", size: 1, mtimeMs: 1, hash: HASH },
                files: {
                  "sub:3:11": { path: "Assignments/Ok/a.pdf", bytes: 1 },
                  "__proto__": { path: "Assignments/Ok/b.pdf", bytes: 1 },
                  "sub:3:12": { path: "/abs/c.pdf", bytes: 1 },
                  "sub:3:13": { path: "Assignments/../d.pdf", bytes: 1 },
                  "sub:3:14": { path: "Assignments\\e.pdf", bytes: 1 },
                  "bad key": { path: "Assignments/Ok/f.pdf", bytes: 1 },
                },
              },
              "6": { dir: "../out", files: { "sub:1:1": { path: "Assignments/g.pdf", bytes: 1 } } },
            },
            announcements: { "7": { dir: "Announcements/x", files: { "9": { path: "Announcements/x/a.pdf", bytes: "big" } } } },
          },
        },
      })
    );
    const manifest = await SyncManifest.load(dir);
    expect(manifest.findAssignment(42, 5)).toEqual({ dir: "Assignments/Ok", files: { "sub:3:11": { path: "Assignments/Ok/a.pdf", bytes: 1 } } });
    expect(manifest.findAssignment(42, 6)).toBeUndefined();
    expect(manifest.findAssignment(42, "x1" as never)).toBeUndefined();
    expect(manifest.findAnnouncement(42, 7)?.files).toEqual({});
    expect(({} as Record<string, unknown>).assignments).toBeUndefined();
    expect(manifest.findAssignment(Number("__proto__"), 1)).toBeUndefined();
  });

  it("an older server that rewrites the manifest drops extras, and a later load reads them as empty", async () => {
    const manifest = await SyncManifest.load(dir);
    manifest.assignment(42, 5).files["sub:3:11"] = { path: "Assignments/X/my files/a.pdf", bytes: 1 };
    manifest.touch();
    await manifest.save();
    // What a 5.2.19 server writes: only version and courses.
    const parsed = await readJson();
    await fs.writeFile(file(MANIFEST_NAME), JSON.stringify({ version: parsed.version, courses: parsed.courses }));
    const later = await SyncManifest.load(dir);
    expect(later.unreadable).toBeUndefined();
    expect(later.findAssignment(42, 5)).toBeUndefined();
  });

  it("keeps the extras of other courses when one course writes", async () => {
    const first = await SyncManifest.load(dir);
    first.assignment(42, 5).dir = "Assignments/X";
    first.assignment(42, 5).files["asg:1"] = { path: "Assignments/X/assignment files/a.pdf", bytes: 1 };
    first.touch();
    await first.save();
    const second = await SyncManifest.load(dir);
    second.assignment(43, 6).dir = "Assignments/Y";
    second.assignment(43, 6).files["asg:2"] = { path: "Assignments/Y/assignment files/b.pdf", bytes: 1 };
    second.touch();
    await second.save();
    const third = await SyncManifest.load(dir);
    expect(third.findAssignment(42, 5)).toBeDefined();
    expect(third.findAssignment(43, 6)).toBeDefined();
  });
});
