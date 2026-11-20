/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * What a sync wrote into its destination, so a rerun can tell the files it
 * downloaded from the user's own. Stored in the destination root, keyed by
 * course and topic, because a file's name is not a reliable key: the name on
 * disk can differ from the name planned (an extension corrected from the
 * file's real type), and one new topic can shift the numbering of duplicates.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { log } from "../utils/logger.js";
import { foldKey } from "./names.js";

export const MANIFEST_NAME = ".brightspace-sync.json";
export const LOCK_NAME = ".brightspace-sync.lock";

export interface ManifestEntry {
  /** Relative to the destination, with "/" separators. */
  path: string;
  bytes: number;
  /** Size and modification time of the file as the sync left it. Absent in an entry that cannot vouch for the file. */
  size?: number;
  mtimeMs?: number;
}

/**
 * True when the file is still exactly as the sync left it. A file the user has
 * since edited (annotations) differs in size or modification time, and an
 * entry with no recorded state (or one written by hand) matches nothing, so
 * neither is ever overwritten.
 */
export function unchangedSinceSync(entry: ManifestEntry, stat: { size: number; mtimeMs: number }): boolean {
  return entry.size !== undefined && entry.mtimeMs !== undefined && stat.size === entry.size && Math.abs(stat.mtimeMs - entry.mtimeMs) < 1;
}

/** The feedback.md the sync wrote for an assignment: what it looked like, so a rerun can tell a refresh from a student's edit. */
export interface FeedbackEntry {
  path: string;
  size: number;
  mtimeMs: number;
  /** SHA-256 of the text the sync rendered. */
  hash: string;
}

/** What a sync saved for one assignment folder, keyed by folder id. Additive: older servers ignore it. */
export interface AssignmentRecord {
  /** The assignment's folder, relative to the destination. */
  dir: string;
  feedback?: FeedbackEntry;
  /** Keyed `sub:<submissionId>:<fileId>`, `asg:<fileId>` or `fb:<fileId>`. */
  files: Record<string, ManifestEntry>;
}

/** What a sync saved for one announcement, keyed by news id; files by attachment id. */
export interface AnnouncementRecord {
  dir: string;
  files: Record<string, ManifestEntry>;
}

interface CourseExtras {
  /** The top-level folders the extras live in ("Assignments", or "Assignments (2)" when Content has a module of that name). */
  assignmentsRoot?: string;
  announcementsRoot?: string;
  assignments: Record<string, AssignmentRecord>;
  announcements: Record<string, AnnouncementRecord>;
}

/** A course or topic id as a key: digits only. */
const ID_KEY = /^\d+$/;
/** A file key inside an extras record: an id, or a kind and ids. Nothing else, so never "__proto__". */
const FILE_KEY = /^(?:[a-z]+:)?\d+(?::\d+)?$/;

/** A recorded path is read back from disk, so it is checked like any other input. */
function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.length > 4096) return false;
  if (value.includes("\\") || value.includes("\u0000") || value.startsWith("/")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const bare = <T>(): Record<string, T> => Object.create(null);

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readEntry(entry: unknown): ManifestEntry | null {
  const { path: rel, bytes, size, mtimeMs } = (entry ?? {}) as Partial<ManifestEntry>;
  if (!validRelativePath(rel) || typeof bytes !== "number" || !Number.isFinite(bytes)) return null;
  return { path: rel, bytes, ...(Number.isFinite(size) && Number.isFinite(mtimeMs) ? { size, mtimeMs } : {}) };
}

/** A root is one folder name: no separator, and a valid relative path. */
function validRoot(value: unknown): value is string {
  return typeof value === "string" && validRelativePath(value) && !value.includes("/");
}

/** A record's folder sits directly under its root, so a record can only ever point inside the extras root. */
function validDir(value: unknown, root: string | undefined): value is string {
  if (root === undefined || !validRelativePath(value)) return false;
  const parts = value.split("/");
  return parts.length === 2 && parts[0] === root;
}

/** True when at least one record has a valid `dir` directly under `root`. Records elsewhere are dropped one by one. */
function anyUnder(records: unknown, root: string): boolean {
  if (!plainObject(records)) return false;
  return Object.entries(records).some(([id, raw]) => ID_KEY.test(id) && plainObject(raw) && validDir(raw.dir, root));
}

const inside = (dir: string, rel: string): boolean => rel.startsWith(`${dir}/`);

function readFiles(value: unknown, dir: string): Record<string, ManifestEntry> {
  const files = bare<ManifestEntry>();
  if (!plainObject(value)) return files;
  for (const [key, entry] of Object.entries(value)) {
    const read = FILE_KEY.test(key) ? readEntry(entry) : null;
    if (read && inside(dir, read.path)) files[key] = read;
  }
  return files;
}

function readFeedback(value: unknown, dir: string): FeedbackEntry | undefined {
  if (!plainObject(value)) return undefined;
  const { path: rel, size, mtimeMs, hash } = value;
  if (!validRelativePath(rel) || !inside(dir, rel) || typeof size !== "number" || !Number.isFinite(size)) return undefined;
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs) || typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) return undefined;
  return { path: rel, size, mtimeMs, hash };
}

export class SyncManifest {
  // No prototype: a course or topic key read from a file must never reach Object.prototype.
  private courses: Record<string, Record<string, ManifestEntry>> = Object.create(null);
  /** What a full-course sync saved beyond the Content area. The Content code never reads it. */
  private extras: Record<string, CourseExtras> = bare();
  private changed = false;
  /** Set when the file exists but could not be read: "reads as empty" is then not the same as "records nothing". */
  unreadable?: string;
  /** Course id to folded path to topic id, so a lookup by path does not scan every entry. */
  private owners = new Map<string, Map<string, number>>();

  private constructor(private readonly file: string) {}

  /** Read the manifest in `root`. A missing, unreadable or malformed one reads as empty. */
  static async load(root: string): Promise<SyncManifest> {
    const manifest = new SyncManifest(path.join(root, MANIFEST_NAME));
    try {
      const parsed = JSON.parse(await fs.readFile(manifest.file, "utf8"));
      const courses = parsed?.courses;
      if (courses && typeof courses === "object" && !Array.isArray(courses)) {
        for (const [courseId, topics] of Object.entries(courses as Record<string, unknown>)) {
          // Ids are numbers: any other key ("__proto__", "constructor") is not a course.
          if (!ID_KEY.test(courseId) || !topics || typeof topics !== "object" || Array.isArray(topics)) continue;
          for (const [topicId, entry] of Object.entries(topics as Record<string, unknown>)) {
            if (!ID_KEY.test(topicId)) continue;
            const { path: rel, bytes, size, mtimeMs } = (entry ?? {}) as Partial<ManifestEntry>;
            if (validRelativePath(rel) && typeof bytes === "number" && Number.isFinite(bytes)) {
              const state = Number.isFinite(size) && Number.isFinite(mtimeMs) ? { size, mtimeMs } : {};
              (manifest.courses[courseId] ??= {})[topicId] = { path: rel, bytes, ...state };
            }
          }
        }
      } else {
        // It parsed, but it is not a manifest: the sync still starts from empty, but a caller must not take it for "nothing saved".
        manifest.unreadable = "it does not hold a course record";
      }
      manifest.readExtras(parsed?.extras);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        manifest.unreadable = error instanceof SyntaxError ? "it is not valid JSON" : ((error as NodeJS.ErrnoException).code ?? "it could not be opened");
        log("WARN", `Course sync: ${MANIFEST_NAME} could not be read; treating it as empty`, error);
      }
    }
    return manifest;
  }

  private readExtras(extras: unknown): void {
    if (!plainObject(extras)) return;
    for (const [courseId, record] of Object.entries(extras)) {
      if (!ID_KEY.test(courseId) || !plainObject(record)) continue;
      const mine = this.course(courseId);
      if (validRoot(record.assignmentsRoot)) mine.assignmentsRoot = record.assignmentsRoot;
      if (validRoot(record.announcementsRoot)) mine.announcementsRoot = record.announcementsRoot;
      // 5.2.21 recorded no root and always used the fixed names. Records written then are adopted, narrowly:
      // the fixed name is adopted when any record of a kind sits directly under it, and only those records are kept.
      if (mine.assignmentsRoot === undefined && anyUnder(record.assignments, "Assignments")) mine.assignmentsRoot = "Assignments";
      if (mine.announcementsRoot === undefined && anyUnder(record.announcements, "Announcements")) mine.announcementsRoot = "Announcements";
      if (plainObject(record.assignments)) {
        for (const [folderId, raw] of Object.entries(record.assignments)) {
          if (!ID_KEY.test(folderId) || !plainObject(raw) || !validDir(raw.dir, mine.assignmentsRoot)) continue;
          const feedback = readFeedback(raw.feedback, raw.dir);
          mine.assignments[folderId] = { dir: raw.dir, ...(feedback ? { feedback } : {}), files: readFiles(raw.files, raw.dir) };
        }
      }
      if (plainObject(record.announcements)) {
        for (const [newsId, raw] of Object.entries(record.announcements)) {
          if (!ID_KEY.test(newsId) || !plainObject(raw) || !validDir(raw.dir, mine.announcementsRoot)) continue;
          mine.announcements[newsId] = { dir: raw.dir, files: readFiles(raw.files, raw.dir) };
        }
      }
    }
  }

  private course(courseId: string | number): CourseExtras {
    return (this.extras[String(courseId)] ??= { assignments: bare(), announcements: bare() });
  }

  /** The top-level folder this course's assignments or announcements go in, as recorded by an earlier run. */
  extrasRoot(courseId: number, kind: "assignments" | "announcements"): string | undefined {
    const course = this.extras[String(courseId)];
    return kind === "assignments" ? course?.assignmentsRoot : course?.announcementsRoot;
  }

  setExtrasRoot(courseId: number, kind: "assignments" | "announcements", name: string): void {
    const course = this.course(courseId);
    if (kind === "assignments") course.assignmentsRoot = name;
    else course.announcementsRoot = name;
    this.changed = true;
  }

  /** What was saved for an assignment folder, or undefined. Read only. */
  findAssignment(courseId: number, folderId: number): AssignmentRecord | undefined {
    return this.extras[String(courseId)]?.assignments[String(folderId)];
  }

  /** Every assignment record kept for a course, by folder id. */
  assignmentRecords(courseId: number): Array<[number, AssignmentRecord]> {
    return Object.entries(this.extras[String(courseId)]?.assignments ?? {}).map(([id, record]) => [Number(id), record]);
  }

  announcementRecords(courseId: number): Array<[number, AnnouncementRecord]> {
    return Object.entries(this.extras[String(courseId)]?.announcements ?? {}).map(([id, record]) => [Number(id), record]);
  }

  findAnnouncement(courseId: number, newsId: number): AnnouncementRecord | undefined {
    return this.extras[String(courseId)]?.announcements[String(newsId)];
  }

  /** The record for an assignment folder, created if need be. Edit it, then call touch(). */
  assignment(courseId: number, folderId: number): AssignmentRecord {
    return (this.course(courseId).assignments[String(folderId)] ??= { dir: "", files: bare() });
  }

  announcement(courseId: number, newsId: number): AnnouncementRecord {
    return (this.course(courseId).announcements[String(newsId)] ??= { dir: "", files: bare() });
  }

  /** Mark the manifest as changed after editing an extras record. */
  touch(): void {
    this.changed = true;
  }

  get(courseId: number, topicId: number): ManifestEntry | undefined {
    return this.courses[String(courseId)]?.[String(topicId)];
  }

  /** Every topic recorded for a course, with the entry kept for it. */
  entries(courseId: number): Array<[number, ManifestEntry]> {
    return Object.entries(this.courses[String(courseId)] ?? {}).map(([topicId, entry]) => [Number(topicId), entry]);
  }

  /** The topic a recorded path belongs to, compared the way the dedupe compares names (foldKey). */
  ownerOf(courseId: number, relPath: string): number | undefined {
    return this.ownersOf(courseId).get(foldKey(relPath));
  }

  private ownersOf(courseId: number): Map<string, number> {
    let index = this.owners.get(String(courseId));
    if (!index) {
      index = new Map();
      for (const [topicId, entry] of Object.entries(this.courses[String(courseId)] ?? {})) index.set(foldKey(entry.path), Number(topicId));
      this.owners.set(String(courseId), index);
    }
    return index;
  }

  set(courseId: number, topicId: number, entry: ManifestEntry): void {
    const index = this.ownersOf(courseId);
    const previous = this.courses[String(courseId)]?.[String(topicId)];
    if (previous && index.get(foldKey(previous.path)) === topicId) index.delete(foldKey(previous.path));
    index.set(foldKey(entry.path), topicId);
    (this.courses[String(courseId)] ??= {})[String(topicId)] = entry;
    this.changed = true;
  }

  /** Write the manifest atomically, only if something changed. */
  async save(): Promise<void> {
    if (!this.changed) return;
    // Only the user reads it: it says which of their files the sync may overwrite.
    // `extras` is written only when it holds something, so a Content-only manifest is byte-for-byte what it always was.
    const extras = Object.fromEntries(
      Object.entries(this.extras).filter(
        ([, c]) => Object.keys(c.assignments).length + Object.keys(c.announcements).length > 0 || c.assignmentsRoot !== undefined || c.announcementsRoot !== undefined
      )
    );
    const body = Object.keys(extras).length > 0 ? { version: 1, courses: this.courses, extras } : { version: 1, courses: this.courses };
    await writeFileAtomic(this.file, `${JSON.stringify(body, null, 1)}\n`, { mode: 0o600 });
    this.changed = false;
  }
}
