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

/** Whether any place a topic was recorded still holds a file. A present copy wins. */
async function presenceOf(candidates: SavedCandidate[]): Promise<Presence> {
  let fallback: Presence | undefined;
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate.path)).isFile()) return { kind: "present", path: candidate.path };
      fallback ??= { kind: "missing", path: candidate.path };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      // Gone, or a folder on the way is gone or is a file now: the file is not there.
      if (code === "ENOENT" || code === "ENOTDIR") fallback ??= { kind: "missing", path: candidate.path };
      // Anything else (permissions, a drive that is not mounted) says nothing about whether it is there.
      else if (fallback?.kind !== "missing") fallback = { kind: "unchecked", path: candidate.path, reason: typeof code === "string" ? code : "it could not be checked" };
    }
  }
  return fallback!;
}

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
        "List the file topics in a course's Content area that the student has not saved yet, by comparing topic ids with what download_file (when it saved to disk) and download_course_files saved. Use this whenever the user asks what is new, what they are missing, or to pull or sync a course. It reads the course's current table of contents fresh, so it also finds a file that was uploaded long ago and only released now. A saved file that has since been deleted is listed in savedFileMissing and needs downloading again. Each listed topic has downloadArgs for download_file; ask the user where to save before downloading, and never guess a folder. If complete is false, or there is a notice, something could not be read: say so, and never tell the user there is nothing new. " +
        FIND_NEW_FILES_GUIDANCE,
      inputSchema: GetUnsavedCourseFilesSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_unsaved_course_files tool called", { args });
        const { courseId, moduleId, syncFolder } = GetUnsavedCourseFilesSchema.parse(args);
        validateContentId(courseId);
        if (syncFolder !== undefined && !path.isAbsolute(syncFolder)) {
          return errorResponse("syncFolder must be an absolute path.", "invalidInput");
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
        if (savedFileMissing.length > 0) {
          notices.push("savedFileMissing lists topics recorded as saved whose file is no longer at that path. They count as not saved: download them again.");
        }
        if (couldNotCheck.length > 0) {
          notices.push("couldNotCheck lists topics recorded as saved whose file could not be checked (for example a drive that is not connected). Do not report them as saved or as missing.");
        }
        if (plan.truncated) {
          notices.push("The course's table of contents is larger than is read, so part of it was cut off. Topics beyond the cut-off are in none of these lists.");
        }
        const complete = state.unreadable.length === 0 && couldNotCheck.length === 0 && !plan.truncated;

        log("INFO", `get_unsaved_course_files: course ${courseId}: ${unsaved.length} unsaved, ${savedFileMissing.length} saved but missing, ${savedCount} saved${complete ? "" : " (incomplete)"}`);

        return toolResponse({
          courseId,
          ...(moduleId !== undefined ? { moduleId } : {}),
          complete,
          fileTopicCount: plan.files.length,
          savedCount,
          unsaved,
          savedFileMissing,
          ...(couldNotCheck.length > 0 ? { couldNotCheck } : {}),
          ...(state.unreadable.length > 0 ? { stateUnreadable: state.unreadable } : {}),
          ...(plan.truncated ? { tocTruncated: true } : {}),
          nonFileCounts: plan.nonFiles,
          ...(notices.length > 0 ? { notice: notices.join(" ") } : {}),
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
