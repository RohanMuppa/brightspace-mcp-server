import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LOCK_NAME, MANIFEST_NAME, SyncManifest, unchangedSinceSync } from "../../src/sync/manifest.js";
import { STALE_LOCK_MS, acquireSyncLock } from "../../src/sync/lock.js";
import { SyncInputError } from "../../src/sync/errors.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-lock-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("SyncManifest", () => {
  it("starts empty and writes nothing until something changes", async () => {
    const manifest = await SyncManifest.load(dir);
    expect(manifest.get(1, 2)).toBeUndefined();
    await manifest.save();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("round-trips entries keyed by course and topic, written atomically", async () => {
    const manifest = await SyncManifest.load(dir);
    manifest.set(42, 10, { path: "Week 1/A.pdf", bytes: 7 });
    manifest.set(43, 10, { path: "Other/A.pdf", bytes: 8 });
    await manifest.save();
    expect(await fs.readdir(dir)).toEqual([MANIFEST_NAME]);
    const again = await SyncManifest.load(dir);
    expect(again.get(42, 10)).toEqual({ path: "Week 1/A.pdf", bytes: 7 });
    expect(again.get(43, 10)).toEqual({ path: "Other/A.pdf", bytes: 8 });
    expect(again.get(42, 11)).toBeUndefined();
  });

  it("keeps recorded size and modification time, and tells an unchanged file from an edited one", async () => {
    const manifest = await SyncManifest.load(dir);
    manifest.set(1, 2, { path: "a.pdf", bytes: 10, size: 10, mtimeMs: 1000.5 });
    await manifest.save();
    const entry = (await SyncManifest.load(dir)).get(1, 2)!;
    expect(entry).toEqual({ path: "a.pdf", bytes: 10, size: 10, mtimeMs: 1000.5 });
    expect(unchangedSinceSync(entry, { size: 10, mtimeMs: 1000.5 })).toBe(true);
    expect(unchangedSinceSync(entry, { size: 11, mtimeMs: 1000.5 })).toBe(false);
    expect(unchangedSinceSync(entry, { size: 10, mtimeMs: 2000 })).toBe(false);
    expect(unchangedSinceSync({ path: "a.pdf", bytes: 10 }, { size: 10, mtimeMs: 1000.5 })).toBe(false);
  });

  it("finds a path's owner case-insensitively", async () => {
    const manifest = await SyncManifest.load(dir);
    manifest.set(42, 10, { path: "Week 1/Notes.pdf", bytes: 1 });
    expect(manifest.ownerOf(42, "week 1/NOTES.pdf")).toBe(10);
    expect(manifest.ownerOf(42, "Week 1/Other.pdf")).toBeUndefined();
    expect(manifest.ownerOf(99, "Week 1/Notes.pdf")).toBeUndefined();
  });

  it.each([
    "not json",
    "[]",
    JSON.stringify({ courses: [] }),
    JSON.stringify({ courses: { 1: { 2: { path: "../../etc/passwd", bytes: 1 } } } }),
    JSON.stringify({ courses: { 1: { 2: { path: "/abs", bytes: 1 } } } }),
    JSON.stringify({ courses: { 1: { 2: { path: "a\\b", bytes: 1 } } } }),
    JSON.stringify({ courses: { 1: { 2: { path: "a//b", bytes: 1 } } } }),
    JSON.stringify({ courses: { 1: { 2: { path: "ok.pdf", bytes: "x" } } } }),
    JSON.stringify({ courses: { 1: { 2: null } } }),
  ])("ignores a malformed or unsafe manifest: %s", async (content) => {
    await fs.writeFile(path.join(dir, MANIFEST_NAME), content);
    expect((await SyncManifest.load(dir)).get(1, 2)).toBeUndefined();
  });
});

describe("acquireSyncLock", () => {
  it("refuses a second sync while the first runs, then allows one after release", async () => {
    const release = await acquireSyncLock(dir);
    await expect(acquireSyncLock(dir)).rejects.toThrow(SyncInputError);
    await expect(acquireSyncLock(dir)).rejects.toThrow(/already running/);
    await release();
    expect(await fs.readdir(dir)).toEqual([]);
    await (await acquireSyncLock(dir))();
  });

  it("takes over a lock whose process is dead", async () => {
    await fs.writeFile(path.join(dir, LOCK_NAME), JSON.stringify({ pid: 2 ** 31 - 2, startedAt: Date.now() }));
    const release = await acquireSyncLock(dir);
    await release();
  });

  it("takes over a lock older than an hour even if the pid is alive", async () => {
    await fs.writeFile(path.join(dir, LOCK_NAME), JSON.stringify({ pid: process.pid, startedAt: Date.now() - STALE_LOCK_MS - 1000 }));
    await (await acquireSyncLock(dir))();
  });

  it("takes over an unreadable lock file", async () => {
    await fs.writeFile(path.join(dir, LOCK_NAME), "garbage");
    await (await acquireSyncLock(dir))();
  });

  it("does not take over a fresh lock held by a live process", async () => {
    await fs.writeFile(path.join(dir, LOCK_NAME), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    await expect(acquireSyncLock(dir)).rejects.toThrow(/already running/);
  });
});
