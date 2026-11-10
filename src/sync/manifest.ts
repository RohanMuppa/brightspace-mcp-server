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

/** A recorded path is read back from disk, so it is checked like any other input. */
function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.length > 4096) return false;
  if (value.includes("\\") || value.includes("\u0000") || value.startsWith("/")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export class SyncManifest {
  private courses: Record<string, Record<string, ManifestEntry>> = {};
  private changed = false;
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
          if (!topics || typeof topics !== "object" || Array.isArray(topics)) continue;
          for (const [topicId, entry] of Object.entries(topics as Record<string, unknown>)) {
            const { path: rel, bytes, size, mtimeMs } = (entry ?? {}) as Partial<ManifestEntry>;
            if (validRelativePath(rel) && typeof bytes === "number" && Number.isFinite(bytes)) {
              const state = Number.isFinite(size) && Number.isFinite(mtimeMs) ? { size, mtimeMs } : {};
              (manifest.courses[courseId] ??= {})[topicId] = { path: rel, bytes, ...state };
            }
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("WARN", `Course sync: ${MANIFEST_NAME} could not be read; treating it as empty`, error);
      }
    }
    return manifest;
  }

  get(courseId: number, topicId: number): ManifestEntry | undefined {
    return this.courses[String(courseId)]?.[String(topicId)];
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
    await writeFileAtomic(this.file, `${JSON.stringify({ version: 1, courses: this.courses }, null, 1)}\n`, { mode: 0o600 });
    this.changed = false;
  }
}
