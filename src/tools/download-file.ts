/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { DownloadFileSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
// Path containment and magic-byte checks belong to secureDownload, which both
// download paths below go through; importing them here only made it look as
// though this file validated anything itself.
import { validateContentId, MAX_FILE_SIZE } from "../utils/file-validator.js";
import { secureDownload } from "../utils/download-helpers.js";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Register download_file tool
 */
export function registerDownloadFile(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "download_file",
    {
      title: "Download File",
      description:
        "Download a file from course content or assignment submissions to a local directory. Use this when the user wants to download, save, or get a file from Brightspace course content or dropbox submissions. IMPORTANT: You MUST ask the user where they want to save the file before calling this tool. Never guess or assume a download directory. After identifying the file to download, suggest a clean readable filename to the user (e.g., 'Lecture 7 - Memory Management.pdf' instead of 'L07_CS251_2026SP_v2.pdf') and ask if they'd like to rename it. Pass their preferred name as customFilename, or omit it to keep the original.",
      inputSchema: DownloadFileSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "download_file tool called", { args });

        // Parse and validate input
        const { courseId, topicId, folderId, fileId, downloadPath, customFilename } =
          DownloadFileSchema.parse(args);

        // Validate courseId
        validateContentId(courseId);

        // Validate download path is absolute
        if (!path.isAbsolute(downloadPath)) {
          return errorResponse(
            "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)"
          );
        }

        // Validate download directory exists and is a directory
        try {
          const stats = await fs.stat(downloadPath);
          if (!stats.isDirectory()) {
            return errorResponse(
              `Download path is not a directory: ${downloadPath}`
            );
          }
        } catch (error: any) {
          if (error?.code === "ENOENT") {
            return errorResponse(
              `Download directory does not exist: ${downloadPath}`
            );
          }
          throw error;
        }

        // Determine download source
        if (topicId !== undefined) {
          // Content file download
          validateContentId(topicId);
          return await downloadContentFile(
            apiClient,
            courseId,
            topicId,
            downloadPath,
            customFilename
          );
        } else if (folderId !== undefined && fileId !== undefined) {
          // Submission file download
          validateContentId(folderId);
          validateContentId(fileId);
          return await downloadSubmissionFile(
            apiClient,
            courseId,
            folderId,
            fileId,
            downloadPath,
            customFilename
          );
        } else {
          return errorResponse(
            "Either topicId (for content files) or both folderId and fileId (for submission files) must be provided"
          );
        }
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}

/**
 * Extract a filename from a Content-Disposition header.
 */
export function parseContentDispositionFilename(
  disposition: string
): string | null {
  const extended = disposition.match(/filename\*\s*=\s*([^;]+)/i);
  if (extended?.[1]) {
    const value = extended[1].trim();
    const parts = value.split("'");
    const encoded = parts.length >= 3 ? parts.slice(2).join("'") : value;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  const plain = disposition.match(/filename\s*=\s*("([^"]*)"|[^;\n]*)/i);
  if (plain) {
    const value = (plain[2] ?? plain[1] ?? "").trim();
    if (value) return value;
  }

  return null;
}

/**
 * Download a content file using topicId
 */
async function downloadContentFile(
  apiClient: D2LApiClient,
  courseId: number,
  topicId: number,
  downloadPath: string,
  customFilename?: string
): Promise<any> {
  log(
    "INFO",
    `Downloading content file: courseId=${courseId}, topicId=${topicId}`
  );

  // Build download URL using D2L API path helper
  const apiPath = apiClient.le(courseId, `/content/topics/${topicId}/file`);

  // Fetch file using getRaw (returns Response object, not parsed JSON)
  const response = await apiClient.getRaw(apiPath);

  // Check Content-Length BEFORE downloading body (prevent memory exhaustion)
  const contentLength = parseInt(
    response.headers.get("Content-Length") ?? "0",
    10
  );
  if (contentLength > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(contentLength / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  // Get filename from Content-Disposition header
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = parseContentDispositionFilename(disposition) ?? "download";

  log("DEBUG", `Content-Disposition filename: ${filename}`);

  // Download body as buffer
  const buffer = Buffer.from(await response.arrayBuffer());

  // Double-check actual size
  if (buffer.length > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(buffer.length / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  // Use custom filename if provided, otherwise use Content-Disposition filename
  const originalFilename = filename;
  const effectiveFilename = customFilename || filename;

  // Use secureDownload for path traversal prevention, file type validation, and conflict resolution
  const result = await secureDownload({
    targetDir: downloadPath,
    filename: effectiveFilename,
    data: buffer,
  });

  log(
    "INFO",
    `File downloaded successfully: ${result.path} (${result.size} bytes, ${result.mime})`
  );

  return toolResponse({
    success: true,
    filePath: result.path,
    fileSize: result.size,
    mimeType: result.mime,
    originalFilename,
    message: `File downloaded successfully to ${result.path}`,
  });
}

/**
 * Download a submission/feedback file using folderId + fileId
 */
async function downloadSubmissionFile(
  apiClient: D2LApiClient,
  courseId: number,
  folderId: number,
  fileId: number,
  downloadPath: string,
  customFilename?: string
): Promise<any> {
  log(
    "INFO",
    `Downloading submission file: courseId=${courseId}, folderId=${folderId}, fileId=${fileId}`
  );

  // D2L API pattern for submission file downloads:
  // GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/(folderId)/submissions/mysubmissions/
  // Then find the file by fileId and construct its download URL

  // First, fetch the submission to get file metadata
  const submissionsPath = apiClient.le(
    courseId,
    `/dropbox/folders/${folderId}/submissions/mysubmissions/`
  );

  interface DropboxSubmission {
    Id: number;
    Files: Array<{
      FileId: number;
      FileName: string;
      Size: number;
    }>;
  }

  const submissions =
    await apiClient.get<DropboxSubmission[]>(submissionsPath);

  if (!submissions || submissions.length === 0) {
    return errorResponse(
      "No submissions found for this assignment. Upload a submission first."
    );
  }

  // Find the file across every submission.
  //
  // A resubmitted assignment answers with one entry per submission, each with
  // its own Files. Reading submissions[0] alone reported "not found" for a file
  // the same response had just returned, and the download URL below needs the
  // id of the submission the file actually belongs to, not the first one's.
  // Files is absent on a submission with no attachments, so it is not assumed.
  let submission: DropboxSubmission | undefined;
  let file: DropboxSubmission["Files"][number] | undefined;

  for (const candidate of submissions) {
    const match = (candidate.Files ?? []).find((f) => f.FileId === fileId);
    if (match) {
      submission = candidate;
      file = match;
      break;
    }
  }

  if (!submission || !file) {
    const available = submissions.flatMap((s) => s.Files ?? []);
    return errorResponse(
      `File ID ${fileId} not found in submission. Available files: ${available.map((f) => `${f.FileName} (ID: ${f.FileId})`).join(", ")}`
    );
  }

  // Check file size before downloading
  if (file.Size > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(file.Size / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  // D2L file download URL pattern for submission files
  // GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/(folderId)/submissions/(submissionId)/files/(fileId)/download
  const downloadApiPath = apiClient.le(
    courseId,
    `/dropbox/folders/${folderId}/submissions/${submission.Id}/files/${fileId}/download`
  );

  // Fetch file
  const response = await apiClient.getRaw(downloadApiPath);

  // Download body as buffer
  const buffer = Buffer.from(await response.arrayBuffer());

  // Double-check actual size
  if (buffer.length > MAX_FILE_SIZE) {
    return errorResponse(
      `File too large (${Math.round(buffer.length / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
    );
  }

  // Use custom filename if provided, otherwise use original submission filename
  const originalFilename = file.FileName;
  const effectiveFilename = customFilename || file.FileName;

  // Use secureDownload for path traversal prevention, file type validation, and conflict resolution
  const result = await secureDownload({
    targetDir: downloadPath,
    filename: effectiveFilename,
    data: buffer,
  });

  log(
    "INFO",
    `Submission file downloaded successfully: ${result.path} (${result.size} bytes, ${result.mime})`
  );

  return toolResponse({
    success: true,
    filePath: result.path,
    fileSize: result.size,
    mimeType: result.mime,
    originalFilename,
    message: `File downloaded successfully to ${result.path}`,
  });
}
