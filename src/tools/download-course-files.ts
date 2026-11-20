/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { DownloadCourseFilesSchema } from "./schemas.js";
import { errorResponse, sanitizeError, withUpdateNotice, FIND_NEW_FILES_GUIDANCE } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { validateContentId } from "../utils/file-validator.js";
import { SyncInputError, syncCourse } from "../sync/course-sync.js";
import { summarizeSync, CONTENT_ONLY_SCOPE } from "../sync/summary.js";
import path from "node:path";
import fs from "node:fs/promises";

/**
 * Register download_course_files tool
 */
export function registerDownloadCourseFiles(server: McpServer, apiClient: D2LApiClient): void {
  server.registerTool(
    "download_course_files",
    {
      title: "Download Course Files",
      description:
        "Download a course's files to a folder on the host computer. By default this saves the Content area only, in sub-folders named after the modules. " + CONTENT_ONLY_SCOPE + " " +
        "TO SAVE MORE IN THE SAME CALL, set everything: true: use it whenever the user asks for the whole course or for everything. It also saves, under the same limits, the student's own assignment submissions, a feedback.md per assignment (score, instructor comments, rubric), the feedback attachments Brightspace lists, the instructor's assignment attachments and announcement attachments. includeSubmissions, includeAssignmentFiles and includeAnnouncementFiles pick them one by one; they cover the whole course even with moduleId. With any of them on, the answer lists only what it still did not look at. The syllabus is never saved by this tool: use get_syllabus for it. " +
        "Layout: Assignments/<assignment>/feedback.md, my files/ (group assignments: submission files/, naming who submitted), assignment files/, feedback files/ (saved when Brightspace lists them), and Announcements/<date title>/. Existing Content is never moved; a module that would share the extras folder's name is saved under the next free name (\"Assignments (2)\"), and the answer names the folder used. " +
        "A rerun skips files already on disk and never overwrites the user's annotated copies. feedback.md is rewritten in place on a rerun when the feedback changed (after grading, say) and the user has not edited it. If they edited it, skip and replace leave it alone and report it; keep_both writes the new text to feedback (2).md and updates that copy from then on (if that copy is edited too, it is left alone and reported). A deleted feedback.md is written again. " +
        "Use this when the user wants a course (or one module) saved, not download_file once per file. Ask where to save before calling; never guess a directory. Use dryRun first on a large course. The answer counts what was downloaded, skipped, failed and not attempted, and what was not a file (links, embedded videos, broken or locked items): do not report those as missing. " +
        "If the run stopped (time limit, size limit, file cap, cancel or an expired session) the extra phases may be incomplete or not have run at all, and the answer says so: call it again to continue. If the answer lists anything as unknown or says the course is not fully saved, Brightspace did not answer for it: tell the user exactly which, and never report it as none, empty or not submitted. " +
        "This tool saves in a folder layout that mirrors the modules; if the student keeps their own layout (they saved with download_file and customFilename), do not use it to pull what is new. " + FIND_NEW_FILES_GUIDANCE,
      inputSchema: DownloadCourseFilesSchema,
    },
    async (args: any, extra?: any) => {
      try {
        log("DEBUG", "download_course_files tool called", { args });
        const { courseId, downloadPath, existing, moduleId, dryRun, maxFiles, maxMinutes, maxTotalMB, everything, ...include } = DownloadCourseFilesSchema.parse(args);
        validateContentId(courseId);

        // Same rules as download_file's disk mode: an absolute path to a directory that exists.
        if (!path.isAbsolute(downloadPath)) {
          return errorResponse(
            "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)", "invalidInput"
          );
        }
        try {
          if (!(await fs.stat(downloadPath)).isDirectory()) {
            return errorResponse(`Download path is not a directory: ${downloadPath}`, "destination");
          }
        } catch (error: any) {
          if (error?.code === "ENOENT") {
            return errorResponse(
              `Download directory does not exist: ${downloadPath}. Create it, then retry, or choose an existing directory.`, "destination"
            );
          }
          throw error;
        }

        let result;
        try {
          // A client that sent a progress token sees each file as it is handled, and a
          // client that cancels the call (or a deadline) ends the run cleanly.
          const progressToken = extra?._meta?.progressToken;
          result = await syncCourse(apiClient, {
            courseId,
            destination: downloadPath,
            existing,
            moduleId,
            includeSubmissions: everything || include.includeSubmissions,
            includeAssignmentFiles: everything || include.includeAssignmentFiles,
            includeAnnouncementFiles: everything || include.includeAnnouncementFiles,
            dryRun,
            maxFiles,
            maxTotalBytes: maxTotalMB * 1024 * 1024,
            deadlineMs: maxMinutes * 60_000,
            signal: extra?.signal,
            onProgress: progressToken === undefined || typeof extra?.sendNotification !== "function"
              ? undefined
              : (event) => {
                  void extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: event.done,
                      total: event.total,
                      message: `${event.type} ${JSON.stringify(event.path)}`,
                    },
                  }).catch(() => {});
                },
          });
        } catch (error) {
          if (error instanceof SyncInputError) return errorResponse(error.message, "invalidInput");
          throw error;
        }

        const response = withUpdateNotice([{ type: "text", text: summarizeSync(result) }]);
        if (result.authError) response.isError = true;
        return response;
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
