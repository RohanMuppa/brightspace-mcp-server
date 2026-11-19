/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Which content topics the student has saved, wherever they put them.
 *
 * `download_file` with a `downloadPath` writes into whatever layout the student
 * keeps, so the manifest of a course sync (which only knows the module-tree
 * layout it wrote) cannot tell what they already have. This ledger is a per-user
 * file, keyed by school, course and topic id, holding the absolute path of each
 * topic `download_file` saved. It also remembers the folders a course sync
 * wrote into, so the sync's own manifests are read in place instead of copied.
 * Why it is shaped this way: docs/internals/downloads.md, "What is already saved".
 *
 * Recording is bookkeeping: it never throws, because a save that worked must
 * not be reported as failed over it.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { getConfigStorePath } from "../utils/config-store.js";
import { log } from "../utils/logger.js";
import { alive } from "./lock.js";
import { SyncManifest } from "./manifest.js";

export const LEDGER_NAME = "saved-topics.json";
/** A damaged ledger is moved to `<ledger>.corrupt-<time>`; readers report any such file until it is removed. */
const ASIDE_MARK = ".corrupt-";

/** Most sync folders remembered per course; the oldest is dropped past this. */
const MAX_SYNC_ROOTS = 20;

export interface SavedTopic {
  /** Absolute path of the file as saved. */
  path: string;
  size: number;
  /** ISO 8601 time of the save. */
  savedAt: string;
  /** The topic's own lastModified, when the saver knew it. */
  lastModified?: string;
}

interface SchoolRecord {
  courses: Record<string, Record<string, SavedTopic>>;
  syncRoots: Record<string, string[]>;
}

interface LedgerFile {
  version: 1;
  schools: Record<string, SchoolRecord>;
}

let ledgerFile: string | undefined;

/** Point the ledger at another file (tests), or back at the default with no argument. */
export function useLedgerFile(file?: string): void {
  ledgerFile = file;
}

/** Next to config.json, in the server's own folder in the home directory. */
function ledgerPath(): string {
  return ledgerFile ?? path.join(path.dirname(getConfigStorePath()), LEDGER_NAME);
}

class LedgerUnreadable extends Error {
  /** `corrupt`: the content is not a ledger at all, the only case where it may be set aside. A newer version or a permission error never is. */
  constructor(message: string, readonly corrupt: boolean) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A course or topic id as a key: digits only, so "__proto__" and "constructor" are never keys. */
const ID_KEY = /^\d+$/;

/** A map with no prototype: a key read from the file can never reach Object.prototype. */
const bare = <T>(): Record<string, T> => Object.create(null);

function describeReadError(error: unknown): { message: string; corrupt: boolean } {
  if (error instanceof SyntaxError) return { message: "it is not valid JSON", corrupt: true };
  const code = (error as NodeJS.ErrnoException)?.code;
  return { message: typeof code === "string" ? code : "it could not be opened", corrupt: false };
}

const emptyLedger = (): LedgerFile => ({ version: 1, schools: bare() });

async function readLedgerFile(file: string): Promise<LedgerFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyLedger();
    const { message, corrupt } = describeReadError(error);
    throw new LedgerUnreadable(message, corrupt);
  }
  if (!isRecord(parsed) || !isRecord(parsed.schools)) throw new LedgerUnreadable("it does not hold a ledger", true);
  // A file from another version is not damaged and is not ours to rewrite or move.
  if (parsed.version !== 1) {
    throw new LedgerUnreadable(`it was written by a different version of the server (ledger version ${JSON.stringify(parsed.version) ?? "missing"})`, false);
  }
  const schools = bare<SchoolRecord>();
  for (const [origin, raw] of Object.entries(parsed.schools)) {
    if (!isRecord(raw)) continue;
    const record: SchoolRecord = { courses: bare(), syncRoots: bare() };
    for (const [courseId, topics] of Object.entries(isRecord(raw.courses) ? raw.courses : {})) {
      if (!ID_KEY.test(courseId) || !isRecord(topics)) continue;
      for (const [topicId, entry] of Object.entries(topics)) {
        if (!ID_KEY.test(topicId)) continue;
        const { path: saved, size, savedAt, lastModified } = (isRecord(entry) ? entry : {}) as Partial<SavedTopic>;
        if (typeof saved !== "string" || !path.isAbsolute(saved) || saved.includes("\u0000")) continue;
        (record.courses[courseId] ??= bare())[topicId] = {
          path: saved,
          size: typeof size === "number" && Number.isFinite(size) ? size : 0,
          savedAt: typeof savedAt === "string" ? savedAt : "",
          ...(typeof lastModified === "string" ? { lastModified } : {}),
        };
      }
    }
    for (const [courseId, roots] of Object.entries(isRecord(raw.syncRoots) ? raw.syncRoots : {})) {
      if (ID_KEY.test(courseId) && Array.isArray(roots)) {
        record.syncRoots[courseId] = roots.filter((r): r is string => typeof r === "string" && path.isAbsolute(r));
      }
    }
    schools[origin] = record;
  }
  return { version: 1, schools };
}

// Cross-process lock around the ledger's read-modify-write. The queue below only
// orders writers inside one process; two servers (or a server and the sync
// command) would otherwise each read the old file and the later rename would
// drop the other's entry. Same pattern as the sync's folder lock (lock.ts): an
// exclusive create, a random token, and a stale owner (dead process, or too
// old) removed only by the holder of a short-lived guard file.
const LOCK_WAIT_MS = 3000;
const LOCK_POLL_MS = 20;
/** A write takes milliseconds: a lock this old belongs to a process that died holding it. */
const LOCK_STALE_MS = 30_000;
const GUARD_STALE_MS = 10_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function staleLock(content: string): boolean {
  try {
    const held = JSON.parse(content) as { pid?: unknown; startedAt?: unknown };
    const age = typeof held.startedAt === "number" ? Date.now() - held.startedAt : Infinity;
    return !(alive(held.pid) && age >= 0 && age < LOCK_STALE_MS);
  } catch {
    return true; // half-written or unreadable: judged like a dead owner's
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function withLedgerLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const guard = `${lock}.takeover`;
  const token = randomBytes(12).toString("hex");
  const body = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token });
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      await fs.writeFile(lock, body, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = await readOrNull(lock);
    if (held === null) continue; // released meanwhile: try again
    if (staleLock(held)) {
      try {
        await fs.writeFile(guard, token, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const guardStat = await fs.stat(guard).catch(() => null);
        if (guardStat && Date.now() - guardStat.mtimeMs > GUARD_STALE_MS) await fs.rm(guard, { force: true });
        else await pause(LOCK_POLL_MS);
        continue;
      }
      try {
        // Read again under the guard: a live owner that took over meanwhile is left alone.
        const again = await readOrNull(lock);
        if (again !== null && staleLock(again)) await fs.rm(lock, { force: true });
      } finally {
        await fs.rm(guard, { force: true });
      }
      continue;
    }
    if (Date.now() >= deadline) throw new Error("the saved-topic ledger is locked by another process");
    await pause(LOCK_POLL_MS);
  }
  try {
    return await work();
  } finally {
    try {
      if (JSON.parse((await readOrNull(lock)) ?? "{}").token === token) await fs.rm(lock, { force: true });
    } catch {
      // Not ours to remove.
    }
  }
}

/** Writers in this process take turns, so two saves finishing together do not queue on the file lock. */
let queue: Promise<unknown> = Promise.resolve();

async function update(change: (school: SchoolRecord) => void, origin: string): Promise<void> {
  const file = ledgerPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withLedgerLock(file, async () => {
    let ledger: LedgerFile;
    try {
      ledger = await readLedgerFile(file);
    } catch (error) {
      // Not a ledger at all: moved aside, never overwritten, then a fresh one starts. Reads report the
      // aside file until the student removes it, because the saves it held are now unknown.
      // Anything else (another version, a permission error) is left exactly as it is, and nothing is written.
      if (!(error instanceof LedgerUnreadable) || !error.corrupt) throw error;
      const aside = `${file}${ASIDE_MARK}${Date.now()}`;
      try {
        await fs.rename(file, aside);
        log("WARN", `Saved-topic ledger was ${error.message}; moved it to ${aside} and started a new one`);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
      }
      ledger = emptyLedger();
    }
    change((ledger.schools[origin] ??= { courses: bare(), syncRoots: bare() }));
    await writeFileAtomic(file, `${JSON.stringify(ledger, null, 1)}\n`, { mode: 0o600 });
  });
}

function enqueue(change: (school: SchoolRecord) => void, origin: string, what: string): Promise<void> {
  const run = queue.then(() => update(change, origin)).catch((error) => {
    // The topic then shows as unsaved, which errs toward downloading it again, never toward claiming it is saved.
    log("WARN", `Could not record ${what} in the saved-topic ledger; the download itself is unaffected`, error);
  });
  queue = run;
  return run;
}

export interface SavedTopicRecord {
  origin: string;
  courseId: number;
  topicId: number;
  path: string;
  size: number;
  lastModified?: string;
}

/** Remember where a topic was saved. Never throws. */
export function recordSavedTopic(record: SavedTopicRecord): Promise<void> {
  return enqueue((school) => {
    (school.courses[String(record.courseId)] ??= bare())[String(record.topicId)] = {
      path: path.resolve(record.path),
      size: record.size,
      savedAt: new Date().toISOString(),
      ...(record.lastModified ? { lastModified: record.lastModified } : {}),
    };
  }, record.origin, `topic ${record.topicId}`);
}

/** Remember a folder a course sync wrote into, so its manifest is read later. Never throws. */
export function recordSyncRoot(origin: string, courseId: number, root: string): Promise<void> {
  return enqueue((school) => {
    const roots = (school.syncRoots[String(courseId)] ??= []);
    const resolved = path.resolve(root);
    const next = [...roots.filter((existing) => existing !== resolved), resolved];
    school.syncRoots[String(courseId)] = next.slice(-MAX_SYNC_ROOTS);
  }, origin, `sync folder for course ${courseId}`);
}

/** One place a topic was recorded as saved. */
export interface SavedCandidate {
  path: string;
  source: "download_file" | "download_course_files";
  size?: number;
  savedAt?: string;
}

export interface Unreadable {
  source: "ledger" | "manifest" | "syncFolder";
  where: string;
  reason: string;
  /** Set when saves recorded earlier are gone from the ledger: they are unknown, not absent. */
  lostRecords?: true;
}

export interface SavedState {
  topics: Map<number, SavedCandidate[]>;
  /** Each source of state that exists but could not be read. Never silently empty. */
  unreadable: Unreadable[];
}

/**
 * Everything recorded as saved for one course: the ledger, and the manifest of
 * every sync folder it remembers plus `extraRoots`. A source that cannot be
 * read is named in `unreadable`; it is not treated as holding nothing.
 */
export async function readSavedState(origin: string, courseId: number, extraRoots: string[] = []): Promise<SavedState> {
  const state: SavedState = { topics: new Map(), unreadable: [] };
  const add = (topicId: number, candidate: SavedCandidate): void => {
    const list = state.topics.get(topicId) ?? [];
    list.push(candidate);
    state.topics.set(topicId, list);
  };

  const roots = new Set(extraRoots.map((root) => path.resolve(root)));
  const file = ledgerPath();
  try {
    const school = (await readLedgerFile(file)).schools[origin];
    for (const [topicId, entry] of Object.entries(school?.courses[String(courseId)] ?? {})) {
      add(Number(topicId), { path: entry.path, source: "download_file", size: entry.size, savedAt: entry.savedAt });
    }
    for (const root of school?.syncRoots[String(courseId)] ?? []) roots.add(root);
  } catch (error) {
    const reason = error instanceof LedgerUnreadable ? error.message : describeReadError(error).message;
    log("WARN", `Saved-topic ledger could not be read (${reason})`, error);
    state.unreadable.push({ source: "ledger", where: file, reason });
  }

  // A damaged ledger that was set aside took its saves with it. Say so until the student removes the file.
  try {
    const base = path.basename(file) + ASIDE_MARK;
    for (const name of (await fs.readdir(path.dirname(file))).filter((entry) => entry.startsWith(base)).sort()) {
      state.unreadable.push({
        source: "ledger",
        where: path.join(path.dirname(file), name),
        reason: "an earlier ledger was damaged and set aside in this file, so earlier saves are unknown. Delete this file once you have checked what is saved",
        lostRecords: true,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      state.unreadable.push({ source: "ledger", where: path.dirname(file), reason: describeReadError(error).message });
    }
  }

  for (const root of roots) {
    // A folder that is not found (moved, deleted, a drive not connected) says nothing about what it held.
    try {
      if (!(await fs.stat(root)).isDirectory()) throw Object.assign(new Error("not a folder"), { code: "ENOTDIR" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      state.unreadable.push({
        source: "syncFolder",
        where: root,
        reason: code === "ENOENT" ? "the folder was not found (moved, deleted, or its drive is not connected)" : `the folder could not be opened (${code ?? "unknown error"})`,
      });
      continue;
    }
    const manifest = await SyncManifest.load(root);
    if (manifest.unreadable) {
      state.unreadable.push({ source: "manifest", where: root, reason: manifest.unreadable });
      continue;
    }
    for (const [topicId, entry] of manifest.entries(courseId)) {
      add(topicId, { path: path.join(root, ...entry.path.split("/")), source: "download_course_files", size: entry.size });
    }
  }
  return state;
}
