/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Whole-course download: every File topic in a course's table of contents,
 * saved into folders that mirror its modules. Shared by the
 * `download_course_files` tool and the `sync` command.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError, NetworkError, RateLimitError } from "../api/errors.js";
import type { D2LApiClient } from "../api/index.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { openContentTopic, parseContentDispositionFilename } from "../tools/download-file.js";
import { isAuthUnavailable, sanitizeError } from "../tools/tool-helpers.js";
import { DownloadError } from "../utils/download-errors.js";
import { expectedLength, secureStreamDownload } from "../utils/download-helpers.js";
import { DISK_MAX_FILE_SIZE } from "../utils/file-validator.js";
import { sensitiveDestination, sensitiveDestinationMessage } from "../utils/sensitive-paths.js";
import { log } from "../utils/logger.js";
import { SyncInputError } from "./errors.js";
import { removeStalePartials } from "./cleanup.js";
import { acquireSyncLock } from "./lock.js";
import { SyncManifest, unchangedSinceSync, type ManifestEntry } from "./manifest.js";
import type { PhaseContext, SaveOutcome, SaveSpec, TextSpec, TextStatus } from "./extras-types.js";
import { syncAssignments, type AssignmentsOutcome } from "./submissions-sync.js";
import { syncAnnouncements, type AnnouncementsOutcome } from "./announcements-sync.js";
import { recordSyncRoot } from "./saved-topics.js";
import { NameSet, fileNameFromTopic, sanitizeComponent, splitExtension } from "./names.js";

export { SyncInputError } from "./errors.js";

export type ExistingMode = "skip" | "replace" | "keep_both";

export const DEFAULT_MAX_FILES = 300;
export const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
/**
 * Pauses before the second and third attempt at a file. The API client already
 * retries 429, 5xx and network errors on the request itself; the sync retries
 * only what it does not: a body that ends early or drops mid-stream, and 408/425.
 */
const RETRY_DELAYS_MS = [1500, 4000];
const RETRYABLE_STATUSES = new Set([408, 425]);
const MAX_DEPTH = 32;
/** More modules and topics than any real course has: a table of contents past this is cut off. */
const MAX_TOC_NODES = 50_000;
/** Longest full path, in characters, kept on Windows (its classic limit is 260). */
const WINDOWS_PATH_BUDGET = 250;
const MIN_NAME_CHARS = 16;
/** The manifest is rewritten after this many files or this long, and always at the end. */
const MANIFEST_BATCH_FILES = 25;
const MANIFEST_BATCH_MS = 2000;

export interface SyncOptions {
  courseId: number;
  /** An existing directory. Module folders are created inside it. */
  destination: string;
  /** What to do with a file already on disk. Default "skip". Only files this sync wrote are ever replaced. */
  existing?: ExistingMode;
  /** Sync only this module and the modules inside it. */
  moduleId?: number;
  /** Also save the student's own submitted files, a feedback.md per assignment and the feedback attachments. */
  includeSubmissions?: boolean;
  /** Also save the instructor's attachments on each assignment. */
  includeAssignmentFiles?: boolean;
  /** Also save announcement attachments. */
  includeAnnouncementFiles?: boolean;
  /** List what would be downloaded; download nothing and create no folders. */
  dryRun?: boolean;
  /** Most files to download in one run. Default 300. */
  maxFiles?: number;
  /** Most bytes to download in one run. Default 5 GB. */
  maxTotalBytes?: number;
  /** Stop cleanly when this aborts; the files not reached are reported as not attempted. */
  signal?: AbortSignal;
  /** Stop cleanly after this many milliseconds of wall-clock time. No limit when unset. */
  deadlineMs?: number;
  /** Pauses between attempts at one file. Default 1.5 s, then 4 s. */
  retryDelaysMs?: number[];
  /** Replaced in tests so backoff costs no time. */
  sleep?: (ms: number) => Promise<void>;
  /** Longest full path kept, shortening names to fit. Default 250 on Windows, unlimited elsewhere. */
  pathBudget?: number;
  onProgress?: (event: SyncProgress) => void;
}

export interface SyncProgress {
  type: "downloaded" | "skipped" | "failed" | "planned" | "unavailable" | "empty";
  path: string;
  bytes?: number;
  error?: string;
  /** Files dealt with so far, and files in the plan. */
  done: number;
  total: number;
}

export type StopReason = "auth" | "cancelled" | "deadline" | "max_total_bytes";

export interface NonFileCounts {
  link: number;
  /** Embedded media (TypeIdentifier ContentService): download_file cannot fetch it. */
  media: number;
  /** IsBroken, or a File topic with no Url. */
  broken: number;
  other: number;
  /** File topics the course says are locked, hidden, not yet open or ended. */
  unavailable: number;
}

export interface SyncResult {
  courseId: number;
  destination: string;
  existing: ExistingMode;
  dryRun: boolean;
  downloaded: Array<{ path: string; bytes: number }>;
  /** Dry run only: the files a real run would download. */
  planned?: string[];
  skippedExisting: number;
  /** Files that are 0 bytes on Brightspace: nothing to save, and not a failure. */
  emptyOnBrightspace: number;
  failed: Array<{ path: string; error: string }>;
  /** Files left alone because of a cap, a deadline, a cancel or a sign-in that stopped the run. */
  notAttempted: number;
  nonFiles: NonFileCounts;
  /** Why the run ended before the end of the plan, when it did (not set for the file cap). */
  stopped?: StopReason;
  /** Set when the run stopped because the session is gone: the sign-in guidance. */
  authError?: string;
  /** The table of contents was larger than the sync reads; the rest of it was ignored. */
  tocTruncated?: boolean;
  /** Set only when assignments were asked for: what the assignments phase saw and saved. */
  assignments?: AssignmentsOutcome;
  /** Set only when announcement files were asked for. */
  announcements?: AnnouncementsOutcome;
  /** Topics the table of contents lists: the files in the plan plus every counter in `nonFiles` (except `unavailable`, which is a subset of the files). */
  tocTopicCount?: number;
}

export interface PlannedFile {
  segments: string[];
  name: string;
  topicId: number;
  /** The topic's own title and last-modified time, when the table gives them. */
  title: string;
  lastModified?: string;
  /** The table-of-contents records its folders and its own name came from, outermost first. */
  sources: object[];
}

/** Longest name a synced file or folder gets before any path budget applies. */
export const FULL_NAME_CHARS = 150;
/** The name cap for each table-of-contents record; a record not in the map gets FULL_NAME_CHARS. */
type NameCaps = ReadonlyMap<object, number>;

type TopicKind = "file" | "link" | "media" | "broken" | "other";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function classify(topic: Record<string, unknown>): TopicKind {
  if (topic.IsBroken === true) return "broken";
  const type = typeof topic.TypeIdentifier === "string" ? topic.TypeIdentifier.toLowerCase() : "";
  if (type === "contentservice") return "media";
  if (type === "link" || topic.TopicType === 2 || topic.TopicType === 3) return "link";
  if (type === "file" || topic.TopicType === 1) {
    return typeof topic.Url === "string" && topic.Url.trim() !== "" ? "file" : "broken";
  }
  return "other";
}

const topicIdOf = (topic: Record<string, unknown>): number | null => {
  const id = Number(topic.TopicId ?? topic.Id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export interface Plan {
  files: PlannedFile[];
  nonFiles: NonFileCounts;
  truncated: boolean;
  /** Every module and topic the walk read, so counters can be checked against a total. Files + the non-file counters = topicsSeen. */
  modulesSeen: number;
  topicsSeen: number;
  /** Entries in a Modules or Topics list that were not objects (or a list that was not a list): not read, so not in any counter. */
  unreadEntries: number;
  /** Topics seen, by `TypeIdentifier` or `TypeIdentifier/TopicType` (`unknown` when there is no identifier), to show what the table holds. At most 50 keys, then `other`. */
  typeCounts: Record<string, number>;
  /** The id of every topic seen, of any type: with `files`, it tells "not a file topic" from "not in the table". */
  topicIds: Set<number>;
}

const MAX_TYPE_KEYS = 50;
/** A course controls these strings: only primitives, only plain characters, and short. */
const typePart = (value: unknown, max: number): string =>
  typeof value === "string" || typeof value === "number" ? String(value).replace(/[^\w.\- ]/g, "_").slice(0, max) : "";

/** The table of contents as folders and files, every name made safe and unique, each within its record's cap in `caps`. */
export function planFiles(toc: unknown, moduleId: number | undefined, caps: NameCaps, reserved: readonly string[] = []): Plan {
  const capOf = (source: object): number => caps.get(source) ?? FULL_NAME_CHARS;
  const files: PlannedFile[] = [];
  const nonFiles: NonFileCounts = { link: 0, media: 0, broken: 0, other: 0, unavailable: 0 };
  let nodes = 0;
  let truncated = false;
  let modulesSeen = 0;
  let topicsSeen = 0;
  let unreadEntries = 0;
  const typeCounts: Record<string, number> = Object.create(null);
  const topicIds = new Set<number>();

  const addTopics = (topics: unknown, segments: string[], sources: object[], names: NameSet): void => {
    if (!Array.isArray(topics)) {
      if (topics !== undefined && topics !== null) unreadEntries++;
      return;
    }
    for (const raw of topics) {
      if (++nodes > MAX_TOC_NODES) {
        truncated = true;
        return;
      }
      const topic = record(raw);
      if (!topic) {
        unreadEntries++;
        continue;
      }
      topicsSeen++;
      // "File" or "File/1": the identifier, then the numeric TopicType only when the table gives one. Neither is "unknown".
      const identifier = typePart(topic.TypeIdentifier, 40) || "unknown";
      const topicType = typeof topic.TopicType === "number" ? typePart(topic.TopicType, 10) : "";
      const rawKey = topicType ? `${identifier}/${topicType}` : identifier;
      const typeKey = rawKey in typeCounts || Object.keys(typeCounts).filter((key) => key !== "other").length < MAX_TYPE_KEYS ? rawKey : "other";
      typeCounts[typeKey] = (typeCounts[typeKey] ?? 0) + 1;
      const kind = classify(topic);
      const topicId = topicIdOf(topic);
      if (topicId !== null) topicIds.add(topicId);
      if (kind !== "file" || topicId === null) {
        nonFiles[kind === "file" ? "broken" : kind]++;
        continue;
      }
      const title = typeof topic.Title === "string" ? topic.Title : "";
      const cap = capOf(topic);
      const name = names.add(sanitizeComponent(fileNameFromTopic(topic.Url as string, title, `File ${topicId}`), `File ${topicId}`, cap), false, cap);
      files.push({
        segments,
        name,
        topicId,
        title,
        ...(typeof topic.LastModifiedDate === "string" && topic.LastModifiedDate !== "" ? { lastModified: topic.LastModifiedDate } : {}),
        sources: [...sources, topic],
      });
    }
  };

  const walk = (container: Record<string, unknown>, segments: string[], sources: object[], depth: number): void => {
    const names = new NameSet(FULL_NAME_CHARS);
    // Top-level folders the extra phases own: a Content module with the same name becomes "Assignments (2)".
    if (depth === 0) for (const name of reserved) names.add(name, true);
    const children: Array<{ module: Record<string, unknown>; segments: string[] }> = [];
    if (container.Modules !== undefined && container.Modules !== null && !Array.isArray(container.Modules)) unreadEntries++;
    if (Array.isArray(container.Modules)) {
      // Only a level that really holds modules past the limit is cut off, not one that ends in an empty list.
      if (depth >= MAX_DEPTH) truncated ||= container.Modules.length > 0;
      else {
        for (const raw of container.Modules) {
          if (++nodes > MAX_TOC_NODES) {
            truncated = true;
            break;
          }
          const module = record(raw);
          if (!module) {
            unreadEntries++;
            continue;
          }
          modulesSeen++;
          const title = typeof module.Title === "string" ? module.Title : "";
          const cap = capOf(module);
          const folder = names.add(sanitizeComponent(title, sanitizeComponent(`Module ${String(module.ModuleId ?? module.Id ?? "")}`.trim(), "Module", cap), cap), true, cap);
          children.push({ module, segments: [...segments, folder] });
        }
      }
    }
    // Folder names are taken before file names, so a file can never claim a module's name.
    addTopics(container.Topics, segments, sources, names);
    for (const child of children) walk(child.module, child.segments, [...sources, child.module], depth + 1);
  };

  const root = record(toc);
  if (root && moduleId === undefined) {
    walk(root, [], [], 0);
  } else if (root) {
    const found = findModule(root, moduleId!, 0);
    if (!found) throw new SyncInputError(`Module ${moduleId} is not in this course's table of contents.`);
    walk({ Modules: [found] }, [], [], 0);
  }
  return { files, nonFiles, truncated, modulesSeen, topicsSeen, unreadEntries, typeCounts, topicIds };
}

/**
 * Plan, shortening names until every full path fits `budget` (when there is
 * one). Only the folders and file on a path that is too long are shortened:
 * a path that already fits keeps its full names, however long another path
 * in the course is.
 */
function planWithinBudget(toc: unknown, moduleId: number | undefined, rootLength: number, budget: number, reserved: readonly string[]): Plan {
  const caps = new Map<object, number>();
  let plan = planFiles(toc, moduleId, caps, reserved);
  for (let round = 0; round < 6 && Number.isFinite(budget); round++) {
    let shortened = false;
    for (const file of plan.files) {
      const length = rootLength + 1 + [...file.segments, file.name].join("/").length;
      if (length <= budget) continue;
      // Scaled from the longest name actually on the path, and always below it, so every round makes progress.
      const longestName = Math.max(...[...file.segments, file.name].map((name) => Array.from(name).length));
      const scaled = Math.floor((longestName * (budget - rootLength)) / (length - rootLength));
      const next = Math.max(MIN_NAME_CHARS, Math.min(longestName - 1, scaled));
      for (const source of file.sources) {
        if (next < (caps.get(source) ?? FULL_NAME_CHARS)) {
          caps.set(source, next);
          shortened = true;
        }
      }
    }
    if (!shortened) break;
    plan = planFiles(toc, moduleId, caps, reserved);
  }
  return plan;
}

function findModule(container: Record<string, unknown>, moduleId: number, depth: number): Record<string, unknown> | null {
  if (!Array.isArray(container.Modules) || depth > MAX_DEPTH) return null;
  for (const raw of container.Modules) {
    const module = record(raw);
    if (!module) continue;
    if (Number(module.ModuleId ?? module.Id) === moduleId) return module;
    const inner = findModule(module, moduleId, depth + 1);
    if (inner) return inner;
  }
  return null;
}

class RefusedFolder extends Error {}

/**
 * Walk `segments` below the destination one folder at a time. A folder that is
 * a symbolic link is refused, not followed, so a link planted in the
 * destination cannot send a download somewhere else. Returns null for a folder
 * that does not exist yet, unless `create` is set.
 */
export async function locateFolder(root: string, segments: string[], create: boolean): Promise<string | null> {
  let current = root;
  for (const segment of segments) {
    // One folder name at a time: a separator would make it several.
    if (/[/\\\u0000]/.test(segment)) throw new RefusedFolder(`Folder "${segment}" would be outside the destination.`);
    const next = path.join(current, segment);
    // Containment by path.relative, so a destination that is a drive root or "/" works.
    const rel = path.relative(root, next);
    if (rel === "" || rel.split(path.sep)[0] === ".." || path.isAbsolute(rel)) {
      throw new RefusedFolder(`Folder "${segment}" would be outside the destination.`);
    }
    let stat;
    try {
      stat = await fs.lstat(next);
    } catch (error) {
      const statCode = (error as NodeJS.ErrnoException).code;
      if (statCode === "ENAMETOOLONG") throw new RefusedFolder("The path is too long for this filesystem.");
      if (statCode !== "ENOENT") throw error;
      if (!create) return null;
      try {
        await fs.mkdir(next);
      } catch (mkdirError) {
        const code = (mkdirError as NodeJS.ErrnoException).code;
        if (code === "ENAMETOOLONG" || code === "ENOENT") throw new RefusedFolder("The path is too long for this filesystem.");
        throw mkdirError;
      }
      current = next;
      continue;
    }
    if (stat.isSymbolicLink()) throw new RefusedFolder(`Folder "${segment}" is a symbolic link; it is not followed.`);
    if (!stat.isDirectory()) throw new RefusedFolder(`"${segment}" is a file, so a folder of that name cannot be created.`);
    current = next;
  }
  return current;
}

const lstatOrNull = async (target: string) => {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first "name (n).ext" from `from` up that is not taken in `dir`. */
async function freeNumberedName(dir: string, name: string, from: number): Promise<string> {
  const { stem, ext } = splitExtension(name);
  for (let n = from; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!(await lstatOrNull(path.join(dir, candidate)))) return candidate;
  }
}

/** Sizes of the file at `name` and of every "name (n).ext" beside it. */
async function copySizes(dir: string, name: string): Promise<number[]> {
  const { stem, ext } = splitExtension(name);
  const copy = new RegExp(`^${escapeRegExp(stem)} \\(\\d+\\)${escapeRegExp(ext)}$`, "i");
  const sizes: number[] = [];
  for (const entry of await fs.readdir(dir)) {
    if (entry.toLowerCase() !== name.toLowerCase() && !copy.test(entry)) continue;
    const stat = await lstatOrNull(path.join(dir, entry));
    if (stat?.isFile()) sizes.push(stat.size);
  }
  return sizes;
}

/**
 * Worth another attempt after a pause: what the API client does not retry
 * itself. It already retries 429, 5xx and network errors on a request, so
 * those are not repeated here (that would multiply the attempts).
 */
function isTransient(error: unknown): boolean {
  if (isAuthUnavailable(error)) return false;
  if (error instanceof DownloadError) return error.kind === "incomplete";
  if (error instanceof ApiError) return RETRYABLE_STATUSES.has(error.status);
  if (error instanceof NetworkError) return false;
  if (error instanceof Error) {
    // What fetch throws when a body is cut or stalls mid-stream.
    const code = String((error.cause as { code?: unknown } | undefined)?.code ?? "");
    return error.message === "terminated" || error.name === "TimeoutError" || /^(ECONN|ETIMEDOUT|EPIPE|UND_ERR)/.test(code);
  }
  return false;
}

/** Run `attempt`, retrying a transient failure after each pause in `delays`. */
async function withBackoff<T>(attempt: () => Promise<T>, delays: number[], sleep: (ms: number) => Promise<void>, signal: AbortSignal): Promise<T> {
  for (let tried = 0; ; tried++) {
    try {
      return await attempt();
    } catch (error) {
      if (signal.aborted || tried >= delays.length || !isTransient(error)) throw error;
      // A cancel or deadline ends the wait at once instead of sitting out the pause.
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(error);
        signal.addEventListener("abort", onAbort, { once: true });
        sleep(delays[tried]).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    }
  }
}

/** One short, fixed-vocabulary reason; nothing from a response body or header is echoed. */
function describeFailure(error: unknown): string {
  if (error instanceof RateLimitError) return "Brightspace is rate limiting requests (429)";
  if (error instanceof ApiError) {
    const note = error.status === 403 ? " (access denied)" : error.status === 404 ? " (file not found)" : "";
    return `Brightspace answered ${error.status}${note}`;
  }
  if (error instanceof NetworkError) return "Could not connect to Brightspace";
  if (error instanceof DownloadError) {
    const first = sanitizeError(error).content[0];
    return first.type === "text" ? first.text : "Could not save the file";
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENAMETOOLONG") return "The path is too long for this filesystem";
  if (code === "EILSEQ") return "The file system does not accept this file or folder name";
  if (isTransient(error)) return "The connection to Brightspace dropped";
  return "Unexpected error";
}

type Outcome =
  | { kind: "saved"; savedName: string; bytes: number }
  | { kind: "duplicate" }
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "overBudget" };

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const textOf = (error: unknown): string => {
  const first = sanitizeError(error).content[0];
  return first.type === "text" ? first.text : "Sign in to Brightspace and try again.";
};

/**
 * Download every File topic of a course into `destination`, folders named
 * after the modules. Files already on disk are left alone unless `existing`
 * says otherwise, so a rerun is a sync. A manifest in the destination records
 * what the sync wrote: only those files are ever replaced, and a rerun finds
 * them again whatever they ended up named.
 *
 * @throws SyncInputError for a bad destination or cap, an unknown moduleId, or
 *   a sync already running into the same destination; the table of contents
 *   failing for any reason but a lost session is thrown too.
 */
export async function syncCourse(apiClient: D2LApiClient, options: SyncOptions): Promise<SyncResult> {
  const existing = options.existing ?? "skip";
  const dryRun = options.dryRun === true;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new SyncInputError("maxFiles must be a whole number of at least 1.");
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes < 1) throw new SyncInputError("maxTotalBytes must be a positive number.");

  const destination = path.resolve(options.destination);
  // Names inside come from the course, so never into the home folder or a credential or system folder.
  const protectedReason = await sensitiveDestination(destination);
  if (protectedReason) throw new SyncInputError(sensitiveDestinationMessage(destination, protectedReason));
  let root: string;
  try {
    if (!(await fs.stat(destination)).isDirectory()) throw new SyncInputError(`Destination is not a directory: ${destination}`);
    root = await fs.realpath(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A dry run creates nothing, so it can preview a destination that is not there yet.
      if (dryRun) {
        root = destination;
      } else throw new SyncInputError(`Destination directory does not exist: ${destination}. Create it, then retry, or choose an existing directory.`);
    } else throw error;
  }

  const release = dryRun ? undefined : await acquireSyncLock(root);
  try {
    // What a killed earlier run (kill -9) left behind, while no other sync holds this folder.
    if (!dryRun) await removeStalePartials(root);
    return await runSync(apiClient, options, { existing, dryRun, maxFiles, maxTotalBytes, destination, root });
  } finally {
    await release?.();
  }
}

async function runSync(
  apiClient: D2LApiClient,
  options: SyncOptions,
  settings: { existing: ExistingMode; dryRun: boolean; maxFiles: number; maxTotalBytes: number; destination: string; root: string },
): Promise<SyncResult> {
  const { courseId, moduleId, onProgress } = options;
  const { existing, dryRun, maxFiles, maxTotalBytes, destination, root } = settings;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? sleepFor;
  const budget = options.pathBudget ?? (process.platform === "win32" ? WINDOWS_PATH_BUDGET : Infinity);

  // One signal for the caller's cancel and the deadline, told apart by the reason.
  const stop = new AbortController();
  const onCallerAbort = () => stop.abort("cancelled");
  if (options.signal?.aborted) onCallerAbort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = options.deadlineMs === undefined ? undefined : setTimeout(() => stop.abort("deadline"), options.deadlineMs);
  timer?.unref();

  try {
    const result: SyncResult = {
      courseId,
      destination,
      existing,
      dryRun,
      downloaded: [],
      ...(dryRun ? { planned: [] } : {}),
      skippedExisting: 0,
      emptyOnBrightspace: 0,
      failed: [],
      notAttempted: 0,
      nonFiles: { link: 0, media: 0, broken: 0, other: 0, unavailable: 0 },
    };

    // Read once, and fresh: a cached copy would hide what the instructor added since the last run.
    let toc: unknown;
    try {
      toc = await apiClient.get<unknown>(apiClient.le(courseId, "/content/toc"), { signal: stop.signal });
    } catch (error) {
      if (stop.signal.aborted) {
        // Cancelled or out of time before the course was even read: nothing was attempted.
        result.stopped = stop.signal.reason === "deadline" ? "deadline" : "cancelled";
        return result;
      }
      if (!isAuthUnavailable(error)) throw error;
      result.stopped = "auth";
      result.authError = textOf(error);
      return result;
    }
    const extras = {
      assignments: options.includeSubmissions === true || options.includeAssignmentFiles === true
        ? { submissions: options.includeSubmissions === true, assignmentFiles: options.includeAssignmentFiles === true }
        : undefined,
      announcements: options.includeAnnouncementFiles === true,
    };
    const reserved = [...(extras.assignments ? ["Assignments"] : []), ...(extras.announcements ? ["Announcements"] : [])];
    const plan = planWithinBudget(toc, moduleId, root.length, budget, reserved);
    result.nonFiles = plan.nonFiles;
    if (plan.truncated) result.tocTruncated = true;
    result.tocTopicCount = plan.topicsSeen;
    const manifest = await SyncManifest.load(root);

    let total = plan.files.length;
    let done = 0;
    const emit = (event: Omit<SyncProgress, "done" | "total">): void => onProgress?.({ ...event, done, total });
    const fail = (rel: string, error: string): void => {
      result.failed.push({ path: rel, error });
      emit({ type: "failed", path: rel, error });
    };
    const stopWith = (reason: StopReason): void => {
      result.stopped ??= reason;
    };
    const abortedReason = (): StopReason => (stop.signal.reason === "deadline" ? "deadline" : "cancelled");

    let attempted = 0;
    let totalBytes = 0;
    let unsaved = 0;
    let lastSaved = Date.now();

    /**
     * One file, from the plan to the disk: the checks and the caps are the same
     * for a Content topic and for an assignment or announcement file, so there is
     * one copy of them. `done`, `attempted` and `totalBytes` are the run's, shared.
     */
    const saveOne = async (spec: SaveSpec): Promise<SaveOutcome> => {
      let segments = spec.segments;
      let name = spec.name;
      let dir: string | null = null;
      let present = false;
      let owned = false;
      // The file is still exactly what the sync wrote: only then may replace overwrite it.
      let untouched = false;
      let ownedEntry: ManifestEntry | undefined;
      try {
        // A file this sync wrote is found again wherever it ended up and whatever it was named.
        const entry = spec.prior;
        if (entry) {
          const parts = entry.path.split("/");
          const entryName = parts.pop()!;
          const entryDir = await locateFolder(root, parts, false);
          const onDisk = entryDir ? await lstatOrNull(path.join(entryDir, entryName)) : null;
          if (entryDir && onDisk?.isFile()) {
            segments = parts;
            name = entryName;
            dir = entryDir;
            present = owned = true;
            untouched = unchangedSinceSync(entry, onDisk);
            ownedEntry = entry;
          }
        }
        if (!owned) {
          dir = await locateFolder(root, segments, false);
          const found = dir === null ? null : await lstatOrNull(path.join(dir, name));
          if (found?.isDirectory()) {
            const blocked = [...segments, name].join("/");
            fail(blocked, "A folder with this name is in the way");
            return { status: "failed", rel: blocked };
          }
          if (found) {
            if (spec.ownedByOther?.([...segments, name].join("/"))) {
              // The planned name is another file's (something added ahead of it shifted the numbering).
              name = await freeNumberedName(dir!, name, 2);
            } else {
              present = true;
            }
          }
        }
      } catch (error) {
        const bad = [...segments, name].join("/");
        fail(bad, error instanceof RefusedFolder ? error.message : "Could not open the destination folder");
        return { status: "failed", rel: bad };
      }

      const rel = [...segments, name].join("/");
      if (Number.isFinite(budget) && root.length + 1 + rel.length > budget) {
        fail(rel, `The path is too long (over ${budget} characters)`);
        return { status: "failed", rel };
      }
      // Present and not (or no longer) exactly what this sync wrote: the user's own file, edited or not ours.
      if (present && (existing === "skip" || (existing === "replace" && !untouched))) {
        result.skippedExisting++;
        emit({ type: "skipped", path: rel });
        return { status: "skipped", rel };
      }
      if (attempted >= maxFiles) {
        result.notAttempted++;
        return { status: "notAttempted", rel };
      }

      // keep_both saves beside the existing file; replace overwrites only what this sync wrote.
      const saveAs = present && existing === "keep_both" ? await freeNumberedName(dir!, name, 1) : name;
      attempted++;
      if (dryRun) {
        const plannedPath = [...segments, saveAs].join("/");
        result.planned!.push(plannedPath);
        emit({ type: "planned", path: plannedPath });
        return { status: "planned", rel: plannedPath };
      }

      try {
        const outcome = await withBackoff(
          () => downloadOne(spec.open, {
            root, dir, segments, name, saveAs,
            replace: present && untouched && existing === "replace",
            replaceEntry: ownedEntry,
            compare: present && existing === "keep_both",
            remainingBytes: maxTotalBytes - totalBytes,
            signal: stop.signal,
          }),
          delays,
          sleep,
          stop.signal,
        );
        if (outcome.kind === "saved") {
          const saved = [...segments, outcome.savedName].join("/");
          result.downloaded.push({ path: saved, bytes: outcome.bytes });
          totalBytes += outcome.bytes;
          // The file as left on disk, so a later edit by the user is noticed.
          const written = await fs.stat(path.join(root, ...segments, outcome.savedName));
          spec.onSaved({ path: saved, bytes: outcome.bytes, size: written.size, mtimeMs: written.mtimeMs });
          // Written in batches (every 25 files or 2 s) and always when the run ends, however it ends.
          unsaved++;
          if (unsaved >= MANIFEST_BATCH_FILES || Date.now() - lastSaved >= MANIFEST_BATCH_MS) {
            await manifest.save();
            unsaved = 0;
            lastSaved = Date.now();
          }
          emit({ type: "downloaded", path: saved, bytes: outcome.bytes });
          if (totalBytes >= maxTotalBytes) stopWith("max_total_bytes");
          return { status: "saved", rel: saved };
        } else if (outcome.kind === "duplicate") {
          result.skippedExisting++;
          emit({ type: "skipped", path: rel });
          return { status: "duplicate", rel };
        } else if (outcome.kind === "empty") {
          result.emptyOnBrightspace++;
          emit({ type: "empty", path: rel });
          return { status: "empty", rel };
        } else if (outcome.kind === "overBudget") {
          stopWith("max_total_bytes");
          result.notAttempted++;
          return { status: "notAttempted", rel };
        }
        result.nonFiles.unavailable++;
        emit({ type: "unavailable", path: rel });
        return { status: "unavailable", rel };
      } catch (error) {
        if (stop.signal.aborted) {
          stopWith(abortedReason());
          result.notAttempted++;
          return { status: "notAttempted", rel };
        } else if (isAuthUnavailable(error)) {
          stopWith("auth");
          result.authError = textOf(error);
          result.notAttempted++;
          return { status: "notAttempted", rel };
        } else if (error instanceof DownloadError && error.kind === "empty") {
          result.emptyOnBrightspace++;
          emit({ type: "empty", path: rel });
          return { status: "empty", rel };
        } else if (error instanceof RefusedFolder) {
          fail(rel, error.message);
        } else {
          log("WARN", `Course sync: ${rel} failed`, error);
          fail(rel, describeFailure(error));
        }
        return { status: "failed", rel };
      }
    };

    /** A small text file the sync renders itself (feedback.md): written when new, refreshed when the render changed and the file is still as written. */
    const saveText = async (spec: TextSpec): Promise<{ status: TextStatus; rel: string }> => {
      const hash = createHash("sha256").update(spec.content).digest("hex");
      let segments = spec.segments;
      let name = spec.name;
      let dir: string | null = null;
      let owned = false;
      let ownedStat: { size: number; mtimeMs: number } | undefined;
      try {
        const prior = spec.prior;
        if (prior) {
          const parts = prior.path.split("/");
          const priorName = parts.pop()!;
          const priorDir = await locateFolder(root, parts, false);
          const onDisk = priorDir ? await lstatOrNull(path.join(priorDir, priorName)) : null;
          if (priorDir && onDisk?.isFile()) {
            segments = parts;
            name = priorName;
            dir = priorDir;
            owned = true;
            ownedStat = onDisk;
          }
        }
        if (!owned) {
          dir = await locateFolder(root, segments, false);
          const found = dir === null ? null : await lstatOrNull(path.join(dir, name));
          if (found?.isDirectory()) {
            const blocked = [...segments, name].join("/");
            fail(blocked, "A folder with this name is in the way");
            return { status: "failed", rel: blocked };
          }
          if (found) {
            // Not written by this sync (the student's own, or a manifest an older server rewrote): left alone.
            const own = [...segments, name].join("/");
            result.skippedExisting++;
            emit({ type: "skipped", path: own });
            return { status: "skipped", rel: own };
          }
        }
      } catch (error) {
        const bad = [...segments, name].join("/");
        fail(bad, error instanceof RefusedFolder ? error.message : "Could not open the destination folder");
        return { status: "failed", rel: bad };
      }

      const rel = [...segments, name].join("/");
      let saveAs = name;
      if (owned) {
        if (spec.prior!.hash === hash) return { status: "unchanged", rel };
        // The student edited it since the sync wrote it: theirs now.
        if (!unchangedSinceSync({ path: rel, bytes: 0, size: spec.prior!.size, mtimeMs: spec.prior!.mtimeMs }, ownedStat!)) return { status: "edited", rel };
        if (existing === "keep_both") saveAs = await freeNumberedName(dir!, name, 2);
      }
      const target = [...segments, saveAs].join("/");
      if (Number.isFinite(budget) && root.length + 1 + target.length > budget) {
        fail(target, `The path is too long (over ${budget} characters)`);
        return { status: "failed", rel: target };
      }
      if (dryRun) {
        result.planned!.push(target);
        emit({ type: "planned", path: target });
        return { status: "planned", rel: target };
      }
      try {
        const folder = await locateFolder(root, segments, true);
        await writeFileAtomic(path.join(folder!, saveAs), spec.content);
        const written = await fs.stat(path.join(folder!, saveAs));
        spec.onWritten({ path: target, size: written.size, mtimeMs: written.mtimeMs, hash });
        result.downloaded.push({ path: target, bytes: written.size });
        emit({ type: "downloaded", path: target, bytes: written.size });
        unsaved++;
        return { status: owned ? "refreshed" : "written", rel: target };
      } catch (error) {
        log("WARN", `Course sync: ${target} failed`, error);
        fail(target, error instanceof RefusedFolder ? error.message : describeFailure(error));
        return { status: "failed", rel: target };
      }
    };

    try {
    for (const file of plan.files) {
      done++;
      if (!result.stopped && stop.signal.aborted) stopWith(abortedReason());
      if (result.stopped) {
        result.notAttempted++;
        continue;
      }
      await saveOne({
        segments: file.segments,
        name: file.name,
        prior: manifest.get(courseId, file.topicId),
        ownedByOther: (candidate) => {
          const owner = manifest.ownerOf(courseId, candidate);
          return owner !== undefined && owner !== file.topicId;
        },
        open: (signal) => openContentTopic(apiClient, courseId, file.topicId, signal),
        onSaved: (entry) => manifest.set(courseId, file.topicId, entry),
      });
    }

    if (extras.assignments || extras.announcements) {
      const context: PhaseContext = {
        apiClient,
        courseId,
        signal: stop.signal,
        dryRun,
        existing,
        manifest,
        stopped: () => {
          if (!result.stopped && stop.signal.aborted) stopWith(abortedReason());
          return result.stopped !== undefined;
        },
        handleStop: (error) => {
          if (stop.signal.aborted) {
            stopWith(abortedReason());
            return true;
          }
          if (isAuthUnavailable(error)) {
            stopWith("auth");
            result.authError = textOf(error);
            return true;
          }
          return false;
        },
        saveFile: async (spec) => {
          total++;
          done++;
          if (!result.stopped && stop.signal.aborted) stopWith(abortedReason());
          if (result.stopped) {
            result.notAttempted++;
            return { status: "notAttempted", rel: [...spec.segments, spec.name].join("/") };
          }
          return saveOne(spec);
        },
        saveText,
        touch: () => manifest.touch(),
      };
      if (extras.assignments) {
        result.assignments = await syncAssignments(context, extras.assignments);
      }
      if (extras.announcements) {
        result.announcements = await syncAnnouncements(context);
      }
    }
    } finally {
      try {
        await manifest.save();
      } finally {
        // So "what is not saved yet" reads this folder's manifest too. Done when the run ends, however it ends,
        // and never before the first download: it can wait for the ledger lock, and the deadline is already running.
        // Only a folder that holds saves is remembered (this run's, or an earlier run's in the manifest): a folder
        // that never held any would later be reported as a missing sync folder. Never throws.
        if (!dryRun && manifest.entries(courseId).length > 0) {
          await recordSyncRoot(apiClient.origin, courseId, root);
        }
      }
    }
    log("INFO", `Course sync ${courseId}: ${result.downloaded.length} downloaded, ${result.skippedExisting} already present, ${result.failed.length} failed, ${result.notAttempted} not attempted`);
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** One attempt at one file: the same topic download `download_file` makes, streamed into the folder. */
async function downloadOne(
  open: SaveSpec["open"],
  where: {
    root: string;
    dir: string | null;
    segments: string[];
    name: string;
    saveAs: string;
    replace: boolean;
    /** The manifest entry the file was judged unchanged against; checked again just before the overwrite. */
    replaceEntry?: ManifestEntry;
    compare: boolean;
    remainingBytes: number;
    signal: AbortSignal;
  },
): Promise<Outcome> {
  const opened = await open(where.signal);
  if ("unavailable" in opened) return { kind: "unavailable" };
  const { response } = opened;

  const expected = expectedLength(response);
  if (!response.body || expected === 0) {
    await response.body?.cancel();
    return { kind: "empty" };
  }
  if (expected !== undefined && expected > DISK_MAX_FILE_SIZE) {
    await response.body.cancel();
    throw new DownloadError("tooLarge", `File exceeds ${DISK_MAX_FILE_SIZE} bytes`);
  }
  // Counted before a byte is written when the server says how big the file is.
  if (expected !== undefined && expected > where.remainingBytes) {
    await response.body.cancel();
    return { kind: "overBudget" };
  }

  // Under keep_both an existing copy of the same size is the same file.
  const sameSize = where.compare && where.dir !== null ? await copySizes(where.dir, where.name) : [];
  if (expected !== undefined && sameSize.includes(expected)) {
    await response.body.cancel();
    return { kind: "duplicate" };
  }

  const dir = await locateFolder(where.root, where.segments, true);
  let result: Awaited<ReturnType<typeof secureStreamDownload>>;
  try {
    result = await secureStreamDownload({
    targetDir: dir!,
    filename: where.saveAs,
    verbatimName: true,
    originalFilename: parseContentDispositionFilename(response.headers.get("Content-Disposition") ?? "") ?? undefined,
    body: response.body,
    // The run's remaining byte budget caps the stream itself, so the limit holds when the server states no Content-Length.
    maxBytes: Math.min(DISK_MAX_FILE_SIZE, where.remainingBytes),
    expectedBytes: expected,
    replaceExisting: where.replace,
    // Minutes can pass between planning and the rename: an edit made meanwhile turns the replace into a copy beside the file.
    replaceGuard: where.replace && where.replaceEntry
      ? async (existingPath) => {
          const now = await lstatOrNull(existingPath);
          return now === null || (now.isFile() && unchangedSinceSync(where.replaceEntry!, now));
        }
      : undefined,
    signal: where.signal,
    });
  } catch (error) {
    if (error instanceof DownloadError && error.kind === "tooLarge" && where.remainingBytes < DISK_MAX_FILE_SIZE) return { kind: "overBudget" };
    throw error;
  }
  if (expected === undefined && sameSize.includes(result.size)) {
    await fs.rm(result.path, { force: true });
    return { kind: "duplicate" };
  }
  return { kind: "saved", savedName: path.basename(result.path), bytes: result.size };
}
