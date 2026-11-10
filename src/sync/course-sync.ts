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
import { retryAfterMsFrom } from "../api/retry.js";
import type { D2LApiClient } from "../api/index.js";
import { openContentTopic, parseContentDispositionFilename } from "../tools/download-file.js";
import { isAuthUnavailable, sanitizeError } from "../tools/tool-helpers.js";
import { DownloadError } from "../utils/download-errors.js";
import { expectedLength, secureStreamDownload } from "../utils/download-helpers.js";
import { DISK_MAX_FILE_SIZE } from "../utils/file-validator.js";
import { log } from "../utils/logger.js";
import { NameSet, fileNameFromTopic, sanitizeComponent, splitExtension } from "./names.js";

export type ExistingMode = "skip" | "replace" | "keep_both";

export const DEFAULT_MAX_FILES = 300;

/** A bad argument to the sync (unknown module, unusable destination, bad cap), as opposed to a failed request. */
export class SyncInputError extends Error {}
/** Pauses before the second and third attempt at a file. */
const RETRY_DELAYS_MS = [1500, 4000];
/** A longer Retry-After is not waited out: the run would sit idle far past any client timeout. */
const MAX_RETRY_AFTER_MS = 30_000;
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_DEPTH = 64;

export interface SyncOptions {
  courseId: number;
  /** An existing directory. Module folders are created inside it. */
  destination: string;
  /** What to do with a file already on disk. Default "skip". */
  existing?: ExistingMode;
  /** Sync only this module and the modules inside it. */
  moduleId?: number;
  /** List what would be downloaded; download nothing and create no folders. */
  dryRun?: boolean;
  /** Most files to download in one run. Default 300. */
  maxFiles?: number;
  /** Pauses between attempts at one file. Default 1.5 s, then 4 s. */
  retryDelaysMs?: number[];
  /** Replaced in tests so backoff costs no time. */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (event: SyncProgress) => void;
}

export interface SyncProgress {
  type: "downloaded" | "skipped" | "failed" | "planned" | "unavailable";
  path: string;
  bytes?: number;
  error?: string;
}

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
  /** Files left alone because of the cap or a sign-in that stopped the run. */
  notAttempted: number;
  nonFiles: NonFileCounts;
  /** Set when the run stopped because the session is gone: the sign-in guidance. */
  authError?: string;
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

/** The table of contents as folders and files, with every name made safe and unique. */
function planFiles(toc: unknown, moduleId: number | undefined): { files: PlannedFile[]; nonFiles: NonFileCounts } {
  const files: PlannedFile[] = [];
  const nonFiles: NonFileCounts = { link: 0, media: 0, broken: 0, other: 0, unavailable: 0 };

  const addTopics = (topics: unknown, segments: string[], names: NameSet): void => {
    if (!Array.isArray(topics)) return;
    for (const raw of topics) {
      const topic = record(raw);
      if (!topic) continue;
      const kind = classify(topic);
      const topicId = topicIdOf(topic);
      if (kind !== "file" || topicId === null) {
        nonFiles[kind === "file" ? "broken" : kind]++;
        continue;
      }
      const title = typeof topic.Title === "string" ? topic.Title : "";
      const name = names.add(fileNameFromTopic(topic.Url as string, title, `File ${topicId}`));
      files.push({ segments, name, topicId });
    }
  };

  const walk = (container: Record<string, unknown>, segments: string[], depth: number): void => {
    const names = new NameSet();
    const children: Array<{ module: Record<string, unknown>; segments: string[] }> = [];
    if (Array.isArray(container.Modules) && depth <= MAX_DEPTH) {
      for (const raw of container.Modules) {
        const module = record(raw);
        if (!module) continue;
        const title = typeof module.Title === "string" ? module.Title : "";
        const folder = names.add(sanitizeComponent(title, `Module ${module.ModuleId ?? module.Id ?? ""}`.trim()), true);
        children.push({ module, segments: [...segments, folder] });
      }
    }
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
  return { files, nonFiles };
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
async function locateFolder(root: string, segments: string[], create: boolean): Promise<string | null> {
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    if (path.dirname(path.resolve(next)) !== path.resolve(current) || !path.resolve(next).startsWith(path.resolve(root) + path.sep)) {
      throw new RefusedFolder(`Folder "${segment}" would be outside the destination.`);
    }
    let stat;
    try {
      stat = await fs.lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return null;
      await fs.mkdir(next);
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

/** The first "name (1).ext", "name (2).ext", ... that is not taken in `dir`. */
async function freeCopyName(dir: string, name: string): Promise<string> {
  const { stem, ext } = splitExtension(name);
  for (let n = 1; ; n++) {
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

function isTransient(error: unknown): boolean {
  if (isAuthUnavailable(error)) return false;
  if (error instanceof RateLimitError || error instanceof NetworkError) return true;
  if (error instanceof ApiError) return TRANSIENT_STATUSES.has(error.status);
  if (error instanceof DownloadError) return error.kind === "incomplete";
  if (error instanceof Error) {
    // What fetch throws when a body is cut or stalls mid-stream.
    const code = String((error.cause as { code?: unknown } | undefined)?.code ?? "");
    return error.message === "terminated" || error.name === "TimeoutError" || error.name === "AbortError" || /^(ECONN|ETIMEDOUT|EPIPE|UND_ERR)/.test(code);
  }
  return false;
}

/** Run `attempt`, retrying a transient failure after each pause in `delays`. */
async function withBackoff<T>(attempt: () => Promise<T>, delays: number[], sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let tried = 0; ; tried++) {
    try {
      return await attempt();
    } catch (error) {
      if (tried >= delays.length || !isTransient(error)) throw error;
      const asked = retryAfterMsFrom(error);
      if (asked !== undefined && asked > MAX_RETRY_AFTER_MS) throw error;
      await sleep(asked ?? delays[tried]);
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
  if (isTransient(error)) return "The connection to Brightspace dropped";
  return "Unexpected error";
}

type Outcome =
  | { kind: "saved"; savedName: string; bytes: number }
  | { kind: "duplicate" }
  | { kind: "unavailable" };

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download every File topic of a course into `destination`, folders named
 * after the modules. Files already on disk are left alone unless `existing`
 * says otherwise, so a rerun is a sync.
 *
 * @throws Error for a bad destination or an unknown moduleId; the table of
 *   contents failing for any reason but a lost session is thrown too.
 */
export async function syncCourse(apiClient: D2LApiClient, options: SyncOptions): Promise<SyncResult> {
  const { courseId, moduleId, onProgress } = options;
  const existing = options.existing ?? "skip";
  const dryRun = options.dryRun === true;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? sleepFor;
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new SyncInputError("maxFiles must be a whole number of at least 1.");

  const destination = path.resolve(options.destination);
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
    result.authError = textOf(error);
    return result;
  }
  const plan = planFiles(toc, moduleId);
  result.nonFiles = plan.nonFiles;

  const fail = (rel: string, error: string): void => {
    result.failed.push({ path: rel, error });
    onProgress?.({ type: "failed", path: rel, error });
  };

  let attempted = 0;
  for (const file of plan.files) {
    const rel = [...file.segments, file.name].join("/");
    if (result.authError) {
      result.notAttempted++;
      continue;
    }

    let dir: string | null;
    try {
      dir = await locateFolder(root, file.segments, false);
    } catch (error) {
      fail(rel, error instanceof RefusedFolder ? error.message : "Could not open the destination folder");
      continue;
    }
    const present = dir === null ? null : await lstatOrNull(path.join(dir, file.name));
    if (present?.isDirectory()) {
      fail(rel, "A folder with this name is in the way");
      continue;
    }
    if (present && existing === "skip") {
      result.skippedExisting++;
      onProgress?.({ type: "skipped", path: rel });
      continue;
    }
    if (attempted >= maxFiles) {
      result.notAttempted++;
      continue;
    }

    // keep_both saves beside the existing file; replace and a new file use the planned name.
    const saveAs = present && existing === "keep_both" ? await freeCopyName(dir!, file.name) : file.name;
    if (dryRun) {
      attempted++;
      const plannedPath = [...file.segments, saveAs].join("/");
      result.planned!.push(plannedPath);
      onProgress?.({ type: "planned", path: plannedPath });
      continue;
    }
    attempted++;

    try {
      const outcome = await withBackoff(
        () => downloadOne(apiClient, courseId, file, { root, dir, saveAs, mode: existing, present: present !== null }),
        delays,
        sleep,
      );
      if (outcome.kind === "saved") {
        const saved = [...file.segments, outcome.savedName].join("/");
        result.downloaded.push({ path: saved, bytes: outcome.bytes });
        onProgress?.({ type: "downloaded", path: saved, bytes: outcome.bytes });
      } else if (outcome.kind === "duplicate") {
        result.skippedExisting++;
        onProgress?.({ type: "skipped", path: rel });
      } else {
        result.nonFiles.unavailable++;
        onProgress?.({ type: "unavailable", path: rel });
      }
    } catch (error) {
      if (isAuthUnavailable(error)) {
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
}

const textOf = (error: unknown): string => {
  const first = sanitizeError(error).content[0];
  return first.type === "text" ? first.text : "Sign in to Brightspace and try again.";
};

/** One attempt at one file: the same topic download `download_file` makes, streamed into the folder. */
async function downloadOne(
  apiClient: D2LApiClient,
  courseId: number,
  file: PlannedFile,
  where: { root: string; dir: string | null; saveAs: string; mode: ExistingMode; present: boolean },
): Promise<Outcome> {
  const opened = await openContentTopic(apiClient, courseId, file.topicId);
  if ("unavailable" in opened) return { kind: "unavailable" };
  const { response } = opened;

  const expected = expectedLength(response);
  if (!response.body) throw new DownloadError("undetectableType", "File is empty (0 bytes)");
  if (expected !== undefined && expected > DISK_MAX_FILE_SIZE) {
    await response.body.cancel();
    throw new DownloadError("tooLarge", `File exceeds ${DISK_MAX_FILE_SIZE} bytes`);
  }

  // Under keep_both an existing copy of the same size is the same file.
  const sameSize = where.mode === "keep_both" && where.present && where.dir !== null
    ? await copySizes(where.dir, file.name)
    : [];
  if (expected !== undefined && sameSize.includes(expected)) {
    await response.body.cancel();
    return { kind: "duplicate" };
  }

  const dir = await locateFolder(where.root, file.segments, true);
  const result = await secureStreamDownload({
    targetDir: dir!,
    filename: where.saveAs,
    originalFilename: parseContentDispositionFilename(response.headers.get("Content-Disposition") ?? "") ?? undefined,
    body: response.body,
    maxBytes: DISK_MAX_FILE_SIZE,
    expectedBytes: expected,
    replaceExisting: where.mode === "replace",
  });
  if (expected === undefined && sameSize.includes(result.size)) {
    await fs.rm(result.path, { force: true });
    return { kind: "duplicate" };
  }
  return { kind: "saved", savedName: path.basename(result.path), bytes: result.size };
}
