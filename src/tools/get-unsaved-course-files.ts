/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { GetUnsavedCourseFilesSchema } from "./schemas.js";
import { errorResponse, sanitizeError, toolResponse, FIND_NEW_FILES_GUIDANCE } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { validateContentId } from "../utils/file-validator.js";
import { SyncInputError, planFiles, type Plan } from "../sync/course-sync.js";
import { readSavedState, type SavedCandidate, type SavedState } from "../sync/saved-topics.js";

export type Listed = {
  topicId: number;
  fileName: string;
  title: string;
  lastModified?: string;
  modulePath: string[];
  downloadArgs: { courseId: number; topicId: number };
};

type Presence =
  | { kind: "present"; path: string }
  | { kind: "marked" }
  | { kind: "missing"; path: string }
  | { kind: "unchecked"; path: string; reason: string };

/**
 * Whether any place a topic was recorded still holds a file ("saved" means something
 * regular is at the path; its size is not compared). A present copy wins. A topic the student
 * marked saved without a file counts as saved but was never checked. A copy whose
 * folder is not found, or that could not be checked, outranks a plain missing file:
 * a drive that is not connected must not read as a deleted file.
 */
async function presenceOf(candidates: SavedCandidate[]): Promise<Presence> {
  let missing: Presence | undefined;
  let unchecked: Presence | undefined;
  let marked = false;
  for (const candidate of candidates) {
    if (candidate.path === undefined) {
      marked = true;
      continue;
    }
    try {
      if ((await fs.stat(candidate.path)).isFile()) return { kind: "present", path: candidate.path };
      missing ??= { kind: "missing", path: candidate.path };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        const folderThere = await fs.stat(path.dirname(candidate.path)).then((s) => s.isDirectory(), () => false);
        if (folderThere) missing ??= { kind: "missing", path: candidate.path };
        else unchecked ??= { kind: "unchecked", path: candidate.path, reason: "the folder it was saved in was not found (moved, deleted, or its drive is not connected)" };
      } else {
        unchecked ??= { kind: "unchecked", path: candidate.path, reason: typeof code === "string" ? `it could not be checked (${code})` : "it could not be checked" };
      }
    }
  }
  if (marked) return { kind: "marked" };
  return unchecked ?? missing!;
}

export interface CourseDiff {
  plan: Plan;
  state: SavedState;
  unsaved: Listed[];
  savedFileMissing: Array<Listed & { savedTo: string }>;
  couldNotCheck: Array<Listed & { savedTo: string; reason: string }>;
  /** Saved, counting both a file found at its recorded path and a topic marked saved without one. */
  savedCount: number;
  /** Of those, topics the student marked saved without a file: the server never checked one. */
  markedSavedCount: number;
}

/** The course's current file topics, set against everything recorded as saved. Shared with mark_course_files_saved. */
export async function diffCourse(apiClient: D2LApiClient, courseId: number, moduleId: number | undefined, extraRoots: string[]): Promise<CourseDiff> {
  // Read fresh, like the sync: a cached copy would hide what the instructor released since.
  // A failure here propagates (sign-in guidance included), never an empty list.
  const toc = await apiClient.get<unknown>(apiClient.le(courseId, "/content/toc"));
  const plan = planFiles(toc, moduleId, new Map());
  const state = await readSavedState(apiClient.origin, courseId, extraRoots);

  const diff: CourseDiff = { plan, state, unsaved: [], savedFileMissing: [], couldNotCheck: [], savedCount: 0, markedSavedCount: 0 };
  for (const file of plan.files) {
    const listed: Listed = {
      topicId: file.topicId,
      fileName: file.name,
      title: file.title,
      ...(file.lastModified ? { lastModified: file.lastModified } : {}),
      modulePath: file.segments,
      downloadArgs: { courseId, topicId: file.topicId },
    };
    const candidates = state.topics.get(file.topicId);
    if (!candidates) {
      diff.unsaved.push(listed);
      continue;
    }
    const presence = await presenceOf(candidates);
    if (presence.kind === "present") diff.savedCount++;
    else if (presence.kind === "marked") {
      diff.savedCount++;
      diff.markedSavedCount++;
    } else if (presence.kind === "missing") diff.savedFileMissing.push({ ...listed, savedTo: presence.path });
    else diff.couldNotCheck.push({ ...listed, savedTo: presence.path, reason: presence.reason });
  }
  return diff;
}

const UNSAVED_NOTE =
  "unsaved lists topics the server has no record of saving. A file the student already has from before this version, or saved another way (browser download, manual copy), appears here too, so ask before downloading everything again. For files the student says they already have, ask which ones and record them with mark_course_files_saved instead of downloading them. A listed topic may not be open yet (locked, hidden or outside its release dates); download_file says why when it can.";

const TOC_NOTE =
  "topics is every topic the table of contents lists: fileTopicCount plus link, media, broken and other in nonFileCounts. If get_course_content shows more topics than this, Brightspace's table of contents does not include them (they are in none of these lists); use get_course_content to see them.";

/**
 * Register get_unsaved_course_files tool
 */
export function registerGetUnsavedCourseFiles(server: McpServer, apiClient: D2LApiClient): void {
  server.registerTool(
    "get_unsaved_course_files",
    {
      title: "Get Unsaved Course Files",
      annotations: { readOnlyHint: true },
      description:
        "List the file topics in a course's Content area that the student has not saved yet, by comparing topic ids with what download_file (when it saved to disk) and download_course_files saved. Use this whenever the user asks what is new, what they are missing, or to pull or sync a course. It reads the course's current table of contents fresh, so it also finds a file that was uploaded long ago and only released now. IMPORTANT: unsaved means the server has no record of saving it. A file the student already has from before this version, or saved another way (browser download, manual copy), appears as unsaved, so ask the user before downloading everything again; for files they already have, use mark_course_files_saved to record them without downloading (ask first, and never mark files as saved just to shorten this list). A listed topic may not be open yet (locked, hidden or outside its release dates); download_file explains why when it can. A saved file that has since been deleted is listed in savedFileMissing and needs downloading again. markedSavedCount counts topics the student marked saved: the server never checked a file for them. Each listed topic has downloadArgs for download_file, plus its title and lastModified when known; ask the user where to save before downloading, and never guess a folder. If complete is false, or there is a notice, something could not be read: say so, and never tell the user there is nothing new. syncFolder is read for this call only (it is not remembered): pass it again on every call. " +
        FIND_NEW_FILES_GUIDANCE,
      inputSchema: GetUnsavedCourseFilesSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_unsaved_course_files tool called", { args });
        const { courseId, moduleId, syncFolder } = GetUnsavedCourseFilesSchema.parse(args);
        validateContentId(courseId);
        if (syncFolder !== undefined) {
          if (!path.isAbsolute(syncFolder)) return errorResponse("syncFolder must be an absolute path.", "invalidInput");
          try {
            if (!(await fs.stat(syncFolder)).isDirectory()) return errorResponse(`syncFolder is not a folder: ${syncFolder}`, "invalidInput");
          } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            return errorResponse(
              code === "ENOENT"
                ? `syncFolder does not exist: ${syncFolder}. Check the path (or that its drive is connected), then retry.`
                : `syncFolder could not be opened: ${syncFolder}${typeof code === "string" ? ` (${code})` : ""}.`,
              "invalidInput",
            );
          }
        }

        let diff: CourseDiff;
        try {
          diff = await diffCourse(apiClient, courseId, moduleId, syncFolder === undefined ? [] : [syncFolder]);
        } catch (error) {
          if (error instanceof SyncInputError) return errorResponse(error.message, "invalidInput");
          throw error;
        }
        const { plan, state, unsaved, savedFileMissing, couldNotCheck, savedCount, markedSavedCount } = diff;

        const notices: string[] = [];
        if (state.unreadable.length > 0) {
          notices.push(
            "Some records of what is saved could not be read (see stateUnreadable). The topics in unsaved have no readable record and may already be saved. " +
            "Do not tell the user nothing is new, or that these files are missing; say the records could not be read, and ask before downloading again."
          );
        }
        if (state.unreadable.some((entry) => entry.lostRecords)) {
          notices.push("The saved-topic ledger was damaged and set aside, so earlier saves are unknown: files saved before then are listed in unsaved even if the student has them.");
        }
        if (markedSavedCount > 0) {
          notices.push(`${markedSavedCount} topic${markedSavedCount === 1 ? " is" : "s are"} marked saved (the student said they have them) and counted in savedCount, but the server never checked a file for them.`);
        }
        if (savedFileMissing.length > 0) {
          notices.push("savedFileMissing lists topics recorded as saved whose file is no longer at that path. They count as not saved: download them again.");
        }
        if (couldNotCheck.length > 0) {
          notices.push("couldNotCheck lists topics recorded as saved whose file or folder could not be checked (for example a drive that is not connected). Do not report them as saved or as missing.");
        }
        if (plan.truncated) {
          notices.push("The course's table of contents is larger than is read, so part of it was cut off. Topics beyond the cut-off are in none of these lists.");
        }
        if (plan.unreadEntries > 0) {
          notices.push(`${plan.unreadEntries} entr${plan.unreadEntries === 1 ? "y" : "ies"} in the table of contents could not be read as topics or modules, so they are in none of these lists.`);
        }
        const complete = state.unreadable.length === 0 && couldNotCheck.length === 0 && !plan.truncated && plan.unreadEntries === 0;

        log("INFO", `get_unsaved_course_files: course ${courseId}: ${unsaved.length} unsaved, ${savedFileMissing.length} saved but missing, ${savedCount} saved${complete ? "" : " (incomplete)"}`);

        // `unavailable` is left out of the counts: this tool does not read each topic's release state, so it would always be 0.
        const { unavailable: _notRead, ...nonFileCounts } = plan.nonFiles;
        return toolResponse({
          courseId,
          ...(moduleId !== undefined ? { moduleId } : {}),
          complete,
          fileTopicCount: plan.files.length,
          savedCount,
          markedSavedCount,
          unsavedNote: UNSAVED_NOTE,
          unsaved,
          savedFileMissing,
          ...(couldNotCheck.length > 0 ? { couldNotCheck } : {}),
          ...(state.unreadable.length > 0 ? { stateUnreadable: state.unreadable } : {}),
          ...(plan.truncated ? { tocTruncated: true } : {}),
          nonFileCounts,
          tableOfContents: {
            modules: plan.modulesSeen,
            topics: plan.topicsSeen,
            unreadEntries: plan.unreadEntries,
            topicTypes: plan.typeCounts,
            note: TOC_NOTE,
          },
          ...(notices.length > 0 ? { notice: notices.join(" ") } : {}),
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
