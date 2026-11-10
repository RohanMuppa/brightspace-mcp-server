/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Whole-course download: every File topic in a course's table of contents,
 * saved into folders that mirror its modules. Shared by the
 * `download_course_files` tool and the `sync` command.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ApiError, NetworkError, RateLimitError } from "../api/errors.js";
import type { D2LApiClient } from "../api/index.js";
import { openContentTopic, parseContentDispositionFilename } from "../tools/download-file.js";
import { isAuthUnavailable, sanitizeError } from "../tools/tool-helpers.js";
import { DownloadError } from "../utils/download-errors.js";
import { expectedLength, secureStreamDownload } from "../utils/download-helpers.js";
import { DISK_MAX_FILE_SIZE } from "../utils/file-validator.js";
import { sensitiveDestination, sensitiveDestinationMessage } from "../utils/sensitive-paths.js";
import { log } from "../utils/logger.js";
import { SyncInputError } from "./errors.js";
import { acquireSyncLock } from "./lock.js";
import { SyncManifest, unchangedSinceSync } from "./manifest.js";
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

export interface SyncOptions {
  courseId: number;
  /** An existing directory. Module folders are created inside it. */
  destination: string;
  /** What to do with a file already on disk. Default "skip". Only files this sync wrote are ever replaced. */
  existing?: ExistingMode;
  /** Sync only this module and the modules inside it. */
  moduleId?: number;
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
  type: "downloaded" | "skipped" | "failed" | "planned" | "unavailable";
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
}

interface PlannedFile {
  segments: string[];
  name: string;
  topicId: number;
}

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

interface Plan {
  files: PlannedFile[];
  nonFiles: NonFileCounts;
  truncated: boolean;
}

/** The table of contents as folders and files, every name made safe and unique, none longer than `cap` characters. */
function planFiles(toc: unknown, moduleId: number | undefined, cap: number): Plan {
  const files: PlannedFile[] = [];
  const nonFiles: NonFileCounts = { link: 0, media: 0, broken: 0, other: 0, unavailable: 0 };
  let nodes = 0;
  let truncated = false;

  const addTopics = (topics: unknown, segments: string[], names: NameSet): void => {
    if (!Array.isArray(topics)) return;
    for (const raw of topics) {
      if (++nodes > MAX_TOC_NODES) {
        truncated = true;
        return;
      }
      const topic = record(raw);
      if (!topic) continue;
      const kind = classify(topic);
      const topicId = topicIdOf(topic);
      if (kind !== "file" || topicId === null) {
        nonFiles[kind === "file" ? "broken" : kind]++;
        continue;
      }
      const title = typeof topic.Title === "string" ? topic.Title : "";
      const name = names.add(sanitizeComponent(fileNameFromTopic(topic.Url as string, title, `File ${topicId}`), `File ${topicId}`, cap));
      files.push({ segments, name, topicId });
    }
  };

  const walk = (container: Record<string, unknown>, segments: string[], depth: number): void => {
    const names = new NameSet(cap);
    const children: Array<{ module: Record<string, unknown>; segments: string[] }> = [];
    if (Array.isArray(container.Modules)) {
      if (depth >= MAX_DEPTH) truncated = true;
      else {
        for (const raw of container.Modules) {
          if (++nodes > MAX_TOC_NODES) {
            truncated = true;
            break;
          }
          const module = record(raw);
          if (!module) continue;
          const title = typeof module.Title === "string" ? module.Title : "";
          const folder = names.add(sanitizeComponent(title, `Module ${module.ModuleId ?? module.Id ?? ""}`.trim(), cap), true);
          children.push({ module, segments: [...segments, folder] });
        }
      }
    }
    // Folder names are taken before file names, so a file can never claim a module's name.
    addTopics(container.Topics, segments, names);
    for (const child of children) walk(child.module, child.segments, depth + 1);
  };

  const root = record(toc);
  if (root && moduleId === undefined) {
    walk(root, [], 0);
  } else if (root) {
    const found = findModule(root, moduleId!, 0);
    if (!found) throw new SyncInputError(`Module ${moduleId} is not in this course's table of contents.`);
    walk({ Modules: [found] }, [], 0);
  }
  return { files, nonFiles, truncated };
}

/** Plan, shortening names until the longest full path fits `budget` (when there is one). */
function planWithinBudget(toc: unknown, moduleId: number | undefined, rootLength: number, budget: number): Plan {
  let cap = 150;
  let plan = planFiles(toc, moduleId, cap);
  for (let round = 0; round < 6 && Number.isFinite(budget) && cap > MIN_NAME_CHARS; round++) {
    const longest = Math.max(0, ...plan.files.map((f) => rootLength + 1 + [...f.segments, f.name].join("/").length));
    if (longest <= budget) break;
    cap = Math.max(MIN_NAME_CHARS, Math.floor((cap * (budget - rootLength)) / (longest - rootLength)));
    plan = planFiles(toc, moduleId, cap);
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
      await sleep(delays[tried]);
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
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENAMETOOLONG") return "The path is too long for this filesystem";
  if (isTransient(error)) return "The connection to Brightspace dropped";
  return "Unexpected error";
}

type Outcome =
  | { kind: "saved"; savedName: string; bytes: number }
  | { kind: "duplicate" }
  | { kind: "unavailable" }
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
      failed: [],
      notAttempted: 0,
      nonFiles: { link: 0, media: 0, broken: 0, other: 0, unavailable: 0 },
    };

    // Read once, and fresh: a cached copy would hide what the instructor added since the last run.
    let toc: unknown;
    try {
      toc = await apiClient.get<unknown>(apiClient.le(courseId, "/content/toc"));
    } catch (error) {
      if (!isAuthUnavailable(error)) throw error;
      result.stopped = "auth";
      result.authError = textOf(error);
      return result;
    }
    const plan = planWithinBudget(toc, moduleId, root.length, budget);
    result.nonFiles = plan.nonFiles;
    if (plan.truncated) result.tocTruncated = true;
    const manifest = await SyncManifest.load(root);

    const total = plan.files.length;
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
    for (const file of plan.files) {
      done++;
      if (!result.stopped && stop.signal.aborted) stopWith(abortedReason());
      if (result.stopped) {
        result.notAttempted++;
        continue;
      }

      let segments = file.segments;
      let name = file.name;
      let dir: string | null = null;
      let present = false;
      let owned = false;
      // The file is still exactly what the sync wrote: only then may replace overwrite it.
      let untouched = false;
      try {
        // A file this sync wrote is found by its topic, wherever it ended up and whatever it was named.
        const entry = manifest.get(courseId, file.topicId);
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
          }
        }
        if (!owned) {
          dir = await locateFolder(root, segments, false);
          const found = dir === null ? null : await lstatOrNull(path.join(dir, name));
          if (found?.isDirectory()) {
            fail([...segments, name].join("/"), "A folder with this name is in the way");
            continue;
          }
          if (found) {
            const owner = manifest.ownerOf(courseId, [...segments, name].join("/"));
            if (owner !== undefined && owner !== file.topicId) {
              // The planned name is another topic's file (a topic added ahead of it shifted the numbering).
              name = await freeNumberedName(dir!, name, 2);
            } else {
              present = true;
            }
          }
        }
      } catch (error) {
        fail([...segments, name].join("/"), error instanceof RefusedFolder ? error.message : "Could not open the destination folder");
        continue;
      }

      const rel = [...segments, name].join("/");
      if (Number.isFinite(budget) && root.length + 1 + rel.length > budget) {
        fail(rel, `The path is too long (over ${budget} characters)`);
        continue;
      }
      // Present and not (or no longer) exactly what this sync wrote: the user's own file, edited or not ours.
      if (present && (existing === "skip" || (existing === "replace" && !untouched))) {
        result.skippedExisting++;
        emit({ type: "skipped", path: rel });
        continue;
      }
      if (attempted >= maxFiles) {
        result.notAttempted++;
        continue;
      }

      // keep_both saves beside the existing file; replace overwrites only what this sync wrote.
      const saveAs = present && existing === "keep_both" ? await freeNumberedName(dir!, name, 1) : name;
      attempted++;
      if (dryRun) {
        const plannedPath = [...segments, saveAs].join("/");
        result.planned!.push(plannedPath);
        emit({ type: "planned", path: plannedPath });
        continue;
      }

      try {
        const outcome = await withBackoff(
          () => downloadOne(apiClient, courseId, file.topicId, {
            root, dir, segments, name, saveAs,
            replace: present && untouched && existing === "replace",
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
          manifest.set(courseId, file.topicId, { path: saved, bytes: outcome.bytes, size: written.size, mtimeMs: written.mtimeMs });
          await manifest.save();
          emit({ type: "downloaded", path: saved, bytes: outcome.bytes });
          if (totalBytes >= maxTotalBytes) stopWith("max_total_bytes");
        } else if (outcome.kind === "duplicate") {
          result.skippedExisting++;
          emit({ type: "skipped", path: rel });
        } else if (outcome.kind === "overBudget") {
          stopWith("max_total_bytes");
          result.notAttempted++;
        } else {
          result.nonFiles.unavailable++;
          emit({ type: "unavailable", path: rel });
        }
      } catch (error) {
        if (stop.signal.aborted) {
          stopWith(abortedReason());
          result.notAttempted++;
        } else if (isAuthUnavailable(error)) {
          stopWith("auth");
          result.authError = textOf(error);
          result.notAttempted++;
        } else if (error instanceof RefusedFolder) {
          fail(rel, error.message);
        } else {
          log("WARN", `Course sync: ${rel} failed`, error);
          fail(rel, describeFailure(error));
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
  apiClient: D2LApiClient,
  courseId: number,
  topicId: number,
  where: {
    root: string;
    dir: string | null;
    segments: string[];
    name: string;
    saveAs: string;
    replace: boolean;
    compare: boolean;
    remainingBytes: number;
    signal: AbortSignal;
  },
): Promise<Outcome> {
  const opened = await openContentTopic(apiClient, courseId, topicId);
  if ("unavailable" in opened) return { kind: "unavailable" };
  const { response } = opened;

  const expected = expectedLength(response);
  if (!response.body) throw new DownloadError("undetectableType", "File is empty (0 bytes)");
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
  const result = await secureStreamDownload({
    targetDir: dir!,
    filename: where.saveAs,
    originalFilename: parseContentDispositionFilename(response.headers.get("Content-Disposition") ?? "") ?? undefined,
    body: response.body,
    maxBytes: DISK_MAX_FILE_SIZE,
    expectedBytes: expected,
    replaceExisting: where.replace,
    signal: where.signal,
  });
  if (expected === undefined && sameSize.includes(result.size)) {
    await fs.rm(result.path, { force: true });
    return { kind: "duplicate" };
  }
  return { kind: "saved", savedName: path.basename(result.path), bytes: result.size };
}
