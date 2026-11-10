/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { DownloadCourseFilesSchema } from "./schemas.js";
import { errorResponse, sanitizeError, withUpdateNotice } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { validateContentId } from "../utils/file-validator.js";
import { SyncInputError, syncCourse } from "../sync/course-sync.js";
import { summarizeSync } from "../sync/summary.js";
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
        "Download every file in a course's Content area to a folder on the host computer, in sub-folders named after the course's modules. Use this when the user wants a whole course (or one module) saved, instead of calling download_file once per file. Ask the user where to save it before calling; never guess a directory. It is safe to run again: files already on disk are skipped by default, so a rerun fetches only what is new and never overwrites the user's annotated copies. Use dryRun first to preview a large course. The answer counts what was downloaded, skipped, failed and not attempted, and what was not a file (web links, embedded videos, broken items, locked items), so do not report those as missing. If the Brightspace session expires mid-run it stops with sign-in instructions and the files already saved are kept; sign in and call it again.",
      inputSchema: DownloadCourseFilesSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "download_course_files tool called", { args });
        const { courseId, downloadPath, existing, moduleId, dryRun, maxFiles } = DownloadCourseFilesSchema.parse(args);
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
          result = await syncCourse(apiClient, { courseId, destination: downloadPath, existing, moduleId, dryRun, maxFiles });
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
