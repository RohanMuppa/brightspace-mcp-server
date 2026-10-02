/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Adapted from @el2060's fork (el2060/brightspace-mcp-server, MIT) —
// permission handling rewritten to this project's ApiError/sanitizeError
// conventions, and the download itself routed through this project's
// secureDownload/MAX_FILE_SIZE (magic-byte file-type validation, path
// containment, filename conflict resolution) instead of writing the buffer
// directly as the fork did.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, ApiError } from "../api/index.js";
import { DownloadDropboxSubmissionFileSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { validateContentId, MAX_FILE_SIZE } from "../utils/file-validator.js";
import { secureDownload } from "../utils/download-helpers.js";
import path from "node:path";
import fs from "node:fs/promises";

interface D2LSubmissionFile {
  FileId: number;
  FileName: string;
  Size: number;
}

interface D2LSubmission {
  Id: number;
  Files: D2LSubmissionFile[];
}

/**
 * Register download_dropbox_submission_file tool.
 */
export function registerDownloadDropboxSubmissionFile(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "download_dropbox_submission_file",
    {
      title: "Download Dropbox Submission File",
      description:
        "Download a specific file from a student's (or group's) dropbox submission to a local directory, " +
        "for an instructor or TA. Use get_dropbox_submissions or get_dropbox_user_submissions first to " +
        "find submissionId and fileId. Requires instructor or TA access to the course. " +
        "IMPORTANT: Ask the user where they want to save the file before calling this tool. " +
        "After identifying the file, suggest a clean readable filename and ask if they'd like to rename it.",
      inputSchema: DownloadDropboxSubmissionFileSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "download_dropbox_submission_file tool called", { args });

        const { courseId, folderId, submissionId, fileId, downloadPath, customFilename } =
          DownloadDropboxSubmissionFileSchema.parse(args);

        validateContentId(courseId);
        validateContentId(folderId);
        validateContentId(submissionId);
        validateContentId(fileId);

        if (!path.isAbsolute(downloadPath)) {
          return errorResponse(
            "downloadPath must be an absolute path (e.g., /Users/username/Downloads or C:\\Users\\username\\Downloads)"
          );
        }

        try {
          const stats = await fs.stat(downloadPath);
          if (!stats.isDirectory()) {
            return errorResponse(`downloadPath is not a directory: ${downloadPath}`);
          }
        } catch (error: any) {
          if (error?.code === "ENOENT") {
            return errorResponse(`Download directory does not exist: ${downloadPath}`);
          }
          throw error;
        }

        // Fetch submission metadata to get the file list and validate fileId.
        const submissionsPath = apiClient.le(
          courseId,
          `/dropbox/folders/${folderId}/submissions/`
        );

        let targetFile: D2LSubmissionFile | null = null;
        try {
          const raw = await apiClient.get<{ Objects: D2LSubmission[] } | D2LSubmission[]>(
            submissionsPath
          );
          const allSubmissions: D2LSubmission[] = Array.isArray(raw) ? raw : raw.Objects ?? [];

          const submission = allSubmissions.find((s) => s.Id === submissionId);
          if (!submission) {
            return errorResponse(
              `Submission ${submissionId} not found in folder ${folderId}. ` +
                "Use get_dropbox_submissions to list available submissions."
            );
          }
          targetFile = submission.Files.find((f) => f.FileId === fileId) ?? null;
          if (!targetFile) {
            const available = submission.Files.map((f) => `${f.FileName} (ID: ${f.FileId})`).join(", ");
            return errorResponse(
              `File ID ${fileId} not found in submission ${submissionId}. Available files: ${available}`
            );
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            return errorResponse(
              "Instructor or TA access required for this course. This tool downloads another user's " +
              "dropbox submission file, which Brightspace only grants to course staff."
            );
          }
          if (error instanceof ApiError && error.status === 404) {
            return errorResponse(`Folder ${folderId} not found in course ${courseId}.`);
          }
          throw error;
        }

        // Check the size Brightspace reported before downloading anything.
        if (targetFile.Size > MAX_FILE_SIZE) {
          return errorResponse(
            `File too large (${Math.round(targetFile.Size / 1024 / 1024)}MB). ` +
              `Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
          );
        }

        const downloadApiPath = apiClient.le(
          courseId,
          `/dropbox/folders/${folderId}/submissions/${submissionId}/files/${fileId}/download`
        );

        let response: Response;
        try {
          response = await apiClient.getRaw(downloadApiPath);
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            return errorResponse(
              "Instructor or TA access required for this course. Brightspace refused this download."
            );
          }
          if (error instanceof ApiError && error.status === 404) {
            return errorResponse("File not found on the server. It may have been deleted.");
          }
          throw error;
        }

        // Check Content-Length before downloading the body (prevent memory exhaustion).
        const contentLength = parseInt(response.headers.get("Content-Length") ?? "0", 10);
        if (contentLength > MAX_FILE_SIZE) {
          return errorResponse(
            `File too large (${Math.round(contentLength / 1024 / 1024)}MB). ` +
              `Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
          );
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        // Double-check the actual size once downloaded.
        if (buffer.length > MAX_FILE_SIZE) {
          return errorResponse(
            `File too large (${Math.round(buffer.length / 1024 / 1024)}MB). ` +
              `Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
          );
        }

        const originalFilename = targetFile.FileName;
        const effectiveFilename = customFilename || originalFilename;

        // secureDownload applies this project's path-containment and
        // magic-byte file-type checks and resolves filename conflicts,
        // rather than writing the fetched buffer straight to disk.
        const result = await secureDownload({
          targetDir: downloadPath,
          filename: effectiveFilename,
          data: buffer,
        });

        log(
          "INFO",
          `download_dropbox_submission_file: saved ${result.path} (${result.size} bytes, ${result.mime})`
        );

        return toolResponse({
          success: true,
          filePath: result.path,
          fileSize: result.size,
          mimeType: result.mime,
          originalFilename,
          message: `File downloaded successfully to ${result.path}`,
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
