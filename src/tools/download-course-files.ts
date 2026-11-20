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
        "Download every file in a course's Content area to a folder on the host computer, in sub-folders named after the course's modules. By default this is only the Content area, not the whole course. Use this when the user wants a whole course (or one module) saved, instead of calling download_file once per file. Ask the user where to save it before calling; never guess a directory. " +
        "TO SAVE THE WHOLE COURSE, set everything: true (use it whenever the user asks for the whole course or for everything). It also saves, in the same call and under the same limits: the student's own assignment submissions, a feedback.md per assignment (score, instructor comments and rubric), the feedback attachments Brightspace lists, the instructor's assignment attachments, and announcement attachments. Or pick includeSubmissions, includeAssignmentFiles and includeAnnouncementFiles one by one. Layout: Assignments/<assignment>/feedback.md, Assignments/<assignment>/my files/, Assignments/<assignment>/assignment files/, Assignments/<assignment>/feedback files/ and Announcements/<date title>/ (group assignments use submission files/ instead of my files/, and name who submitted). Feedback attachments are saved when Brightspace lists them. feedback.md is rewritten on a rerun when the feedback changed (for example after grading), unless the student edited it. These extras cover the whole course even when moduleId is given. " +
        "It is safe to run again: files already on disk are skipped by default, so a rerun fetches only what is new and never overwrites the user's annotated copies. Use dryRun first to preview a large course. The answer counts what was downloaded, skipped, failed and not attempted, and what was not a file (web links, embedded videos, broken items, locked items), so do not report those as missing. " +
        "If the answer lists something as unknown or says the course is not fully saved, Brightspace did not answer for it: tell the user exactly which, and never report it as none, empty or not submitted. " + CONTENT_ONLY_SCOPE + " With everything: true the answer lists only what it still did not look at. If the Brightspace session expires mid-run it stops with sign-in instructions and the files already saved are kept; sign in and call it again. This tool saves in a folder layout that mirrors the modules; if the student keeps their own layout (they saved with download_file and customFilename), do not use it to pull what is new. " + FIND_NEW_FILES_GUIDANCE,
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
