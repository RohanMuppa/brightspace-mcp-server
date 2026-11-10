import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("leaves nothing behind after taking over a stale lock", async () => {
    await fs.writeFile(path.join(dir, LOCK_NAME), JSON.stringify({ pid: 2 ** 31 - 2, startedAt: Date.now() }));
    const release = await acquireSyncLock(dir);
    expect((await fs.readdir(dir)).sort()).toEqual([LOCK_NAME]);
    await release();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("lets exactly one of several processes take over a stale lock", async () => {
    await fs.writeFile(path.join(dir, LOCK_NAME), JSON.stringify({ pid: 2 ** 31 - 2, startedAt: Date.now() }));
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => acquireSyncLock(dir)));
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    for (const o of outcomes) if (o.status === "rejected") expect(o.reason).toBeInstanceOf(SyncInputError);
    expect((await fs.readdir(dir)).sort()).toEqual([LOCK_NAME]);
  });

  it("release removes only a lock that still holds its own token", async () => {
    const release = await acquireSyncLock(dir);
    // Another sync took the file over (after judging ours stale): its lock must survive our late release.
    await fs.writeFile(path.join(dir, LOCK_NAME), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "someone-else" }));
    await release();
    expect(JSON.parse(await fs.readFile(path.join(dir, LOCK_NAME), "utf8")).token).toBe("someone-else");
  });

  it("release is harmless when the lock is already gone", async () => {
    const release = await acquireSyncLock(dir);
    await fs.rm(path.join(dir, LOCK_NAME));
    await expect(release()).resolves.toBeUndefined();
  });

  it("re-reads before removing: a lock that turned live after it was judged stale is left alone", async () => {
    const file = path.join(dir, LOCK_NAME);
    const live = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: "live" });
    await fs.writeFile(file, live);
    // The first read (the judgement) sees a stale lock; the file itself is live by the re-read.
    const staleView = JSON.stringify({ pid: 2 ** 31 - 2, startedAt: Date.now() });
    const real = fs.readFile;
    let first = true;
    const spy = vi.spyOn(fs, "readFile").mockImplementation((async (target: any, ...rest: any[]) => {
      if (first && String(target) === file) {
        first = false;
        return staleView;
      }
      return (real as any)(target, ...rest);
    }) as any);
    try {
      await expect(acquireSyncLock(dir)).rejects.toThrow(/already running/);
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(file, "utf8")).toBe(live);
    expect((await fs.readdir(dir)).sort()).toEqual([LOCK_NAME]);
  });

  it("takes over a takeover guard left by a process that died inside it", async () => {
    await fs.writeFile(path.join(dir, LOCK_NAME), JSON.stringify({ pid: 2 ** 31 - 2, startedAt: Date.now() }));
    const guard = path.join(dir, `${LOCK_NAME}.takeover`);
    await fs.writeFile(guard, "dead");
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(guard, old, old);
    await (await acquireSyncLock(dir))();
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
