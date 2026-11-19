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

import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { getConfigStorePath } from "../utils/config-store.js";
import { log } from "../utils/logger.js";
import { SyncManifest } from "./manifest.js";

export const LEDGER_NAME = "saved-topics.json";

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
  constructor(message: string, readonly corrupt: boolean) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function describeReadError(error: unknown): { message: string; corrupt: boolean } {
  if (error instanceof SyntaxError) return { message: "it is not valid JSON", corrupt: true };
  const code = (error as NodeJS.ErrnoException)?.code;
  return { message: typeof code === "string" ? code : "it could not be opened", corrupt: false };
}

async function readLedgerFile(file: string): Promise<LedgerFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, schools: {} };
    const { message, corrupt } = describeReadError(error);
    throw new LedgerUnreadable(message, corrupt);
  }
  if (!isRecord(parsed) || !isRecord(parsed.schools)) throw new LedgerUnreadable("it does not hold a ledger", true);
  const schools: Record<string, SchoolRecord> = {};
  for (const [origin, raw] of Object.entries(parsed.schools)) {
    if (!isRecord(raw)) continue;
    const record: SchoolRecord = { courses: {}, syncRoots: {} };
    for (const [courseId, topics] of Object.entries(isRecord(raw.courses) ? raw.courses : {})) {
      if (!isRecord(topics)) continue;
      for (const [topicId, entry] of Object.entries(topics)) {
        const { path: saved, size, savedAt, lastModified } = (isRecord(entry) ? entry : {}) as Partial<SavedTopic>;
        if (typeof saved !== "string" || !path.isAbsolute(saved) || saved.includes("\u0000")) continue;
        (record.courses[courseId] ??= {})[topicId] = {
          path: saved,
          size: typeof size === "number" && Number.isFinite(size) ? size : 0,
          savedAt: typeof savedAt === "string" ? savedAt : "",
          ...(typeof lastModified === "string" ? { lastModified } : {}),
        };
      }
    }
    for (const [courseId, roots] of Object.entries(isRecord(raw.syncRoots) ? raw.syncRoots : {})) {
      if (Array.isArray(roots)) record.syncRoots[courseId] = roots.filter((r): r is string => typeof r === "string" && path.isAbsolute(r));
    }
    schools[origin] = record;
  }
  return { version: 1, schools };
}

/** Writers in this process take turns, so two saves finishing together do not lose one another's entry. */
let queue: Promise<unknown> = Promise.resolve();

async function update(change: (school: SchoolRecord) => void, origin: string): Promise<void> {
  const file = ledgerPath();
  let ledger: LedgerFile;
  try {
    ledger = await readLedgerFile(file);
  } catch (error) {
    if (!(error instanceof LedgerUnreadable) || !error.corrupt) throw error;
    // A file that is not a ledger is moved aside, not overwritten, then a fresh one starts.
    const aside = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, aside);
    log("WARN", `Saved-topic ledger was ${error.message}; moved it to ${aside} and started a new one`);
    ledger = { version: 1, schools: {} };
  }
  change((ledger.schools[origin] ??= { courses: {}, syncRoots: {} }));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(ledger, null, 1)}\n`, { mode: 0o600 });
}

function enqueue(change: (school: SchoolRecord) => void, origin: string, what: string): Promise<void> {
  const run = queue.then(() => update(change, origin)).catch((error) => {
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
    (school.courses[String(record.courseId)] ??= {})[String(record.topicId)] = {
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

export interface SavedState {
  topics: Map<number, SavedCandidate[]>;
  /** Each source of state that exists but could not be read. Never silently empty. */
  unreadable: Array<{ source: "ledger" | "manifest"; where: string; reason: string }>;
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

  for (const root of roots) {
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
