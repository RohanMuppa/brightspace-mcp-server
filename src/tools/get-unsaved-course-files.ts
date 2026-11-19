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
import { SyncInputError, planFiles } from "../sync/course-sync.js";
import { readSavedState, type SavedCandidate } from "../sync/saved-topics.js";

type Listed = { topicId: number; fileName: string; modulePath: string[]; downloadArgs: { courseId: number; topicId: number } };

type Presence = { kind: "present"; path: string } | { kind: "missing"; path: string } | { kind: "unchecked"; path: string; reason: string };

/**
 * Whether any place a topic was recorded still holds a file ("saved" means something
 * regular is at the path; its size is not compared). A present copy wins. A copy whose
 * folder is not found, or that could not be checked, outranks a plain missing file:
 * a drive that is not connected must not read as a deleted file.
 */
async function presenceOf(candidates: SavedCandidate[]): Promise<Presence> {
  let missing: Presence | undefined;
  let unchecked: Presence | undefined;
  for (const candidate of candidates) {
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
  return unchecked ?? missing!;
}

const UNSAVED_NOTE =
  "unsaved lists topics the server has no record of saving. A file the student already has from before this version, or saved another way (browser download, manual copy), appears here too, so ask before downloading everything again. A listed topic may not be open yet (locked, hidden or outside its release dates); download_file says why when it can.";

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
        "List the file topics in a course's Content area that the student has not saved yet, by comparing topic ids with what download_file (when it saved to disk) and download_course_files saved. Use this whenever the user asks what is new, what they are missing, or to pull or sync a course. It reads the course's current table of contents fresh, so it also finds a file that was uploaded long ago and only released now. IMPORTANT: unsaved means the server has no record of saving it. A file the student already has from before this version, or saved another way (browser download, manual copy), appears as unsaved, so ask the user before downloading everything again. A listed topic may not be open yet (locked, hidden or outside its release dates); download_file explains why when it can. A saved file that has since been deleted is listed in savedFileMissing and needs downloading again. Each listed topic has downloadArgs for download_file; ask the user where to save before downloading, and never guess a folder. If complete is false, or there is a notice, something could not be read: say so, and never tell the user there is nothing new. syncFolder is read for this call only (it is not remembered): pass it again on every call. " +
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

        // Read fresh, like the sync: a cached copy would hide what the instructor released since.
        // A failure here is an error answer (sign-in guidance included), never an empty list.
        const toc = await apiClient.get<unknown>(apiClient.le(courseId, "/content/toc"));
        let plan;
        try {
          plan = planFiles(toc, moduleId, new Map());
        } catch (error) {
          if (error instanceof SyncInputError) return errorResponse(error.message, "invalidInput");
          throw error;
        }

        const state = await readSavedState(apiClient.origin, courseId, syncFolder === undefined ? [] : [syncFolder]);

        const unsaved: Listed[] = [];
        const savedFileMissing: Array<Listed & { savedTo: string }> = [];
        const couldNotCheck: Array<Listed & { savedTo: string; reason: string }> = [];
        let savedCount = 0;
        for (const file of plan.files) {
          const listed: Listed = {
            topicId: file.topicId,
            fileName: file.name,
            modulePath: file.segments,
            downloadArgs: { courseId, topicId: file.topicId },
          };
          const candidates = state.topics.get(file.topicId);
          if (!candidates) {
            unsaved.push(listed);
            continue;
          }
          const presence = await presenceOf(candidates);
          if (presence.kind === "present") savedCount++;
          else if (presence.kind === "missing") savedFileMissing.push({ ...listed, savedTo: presence.path });
          else couldNotCheck.push({ ...listed, savedTo: presence.path, reason: presence.reason });
        }

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
        if (savedFileMissing.length > 0) {
          notices.push("savedFileMissing lists topics recorded as saved whose file is no longer at that path. They count as not saved: download them again.");
        }
        if (couldNotCheck.length > 0) {
          notices.push("couldNotCheck lists topics recorded as saved whose file or folder could not be checked (for example a drive that is not connected). Do not report them as saved or as missing.");
        }
        if (plan.truncated) {
          notices.push("The course's table of contents is larger than is read, so part of it was cut off. Topics beyond the cut-off are in none of these lists.");
        }
        const complete = state.unreadable.length === 0 && couldNotCheck.length === 0 && !plan.truncated;

        log("INFO", `get_unsaved_course_files: course ${courseId}: ${unsaved.length} unsaved, ${savedFileMissing.length} saved but missing, ${savedCount} saved${complete ? "" : " (incomplete)"}`);

        // `unavailable` is left out of the counts: this tool does not read each topic's release state, so it would always be 0.
        const { unavailable: _notRead, ...nonFileCounts } = plan.nonFiles;
        return toolResponse({
          courseId,
          ...(moduleId !== undefined ? { moduleId } : {}),
          complete,
          fileTopicCount: plan.files.length,
          savedCount,
          unsavedNote: UNSAVED_NOTE,
          unsaved,
          savedFileMissing,
          ...(couldNotCheck.length > 0 ? { couldNotCheck } : {}),
          ...(state.unreadable.length > 0 ? { stateUnreadable: state.unreadable } : {}),
          ...(plan.truncated ? { tocTruncated: true } : {}),
          nonFileCounts,
          ...(notices.length > 0 ? { notice: notices.join(" ") } : {}),
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
