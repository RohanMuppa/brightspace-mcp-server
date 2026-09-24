/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, ApiError, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetSyllabusSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { secureDownload } from "../utils/download-helpers.js";
import { MAX_FILE_SIZE } from "../utils/file-validator.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { log } from "../utils/logger.js";
import path from "node:path";
import fs from "node:fs/promises";

// D2L Overview API response shape
interface CourseOverview {
  Description: { Text: string; Html: string } | null;
}

/**
 * Register get_syllabus tool
 */
export function registerGetSyllabus(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_syllabus",
    {
      title: "Get Course Syllabus",
      description:
        "Fetch the syllabus/overview text and optional attachment for a course. Returns the course overview description as markdown. If downloadPath is provided, also downloads the syllabus attachment (e.g. PDF). IMPORTANT: You MUST ask the user where they want to save the file before calling this tool with a downloadPath.",
      inputSchema: GetSyllabusSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_syllabus tool called", { args });

        const { courseId, downloadPath } = GetSyllabusSchema.parse(args);

        // Validate downloadPath if provided
        if (downloadPath !== undefined) {
          if (!path.isAbsolute(downloadPath)) {
            return errorResponse(
              "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)"
            );
          }
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
        }

        // Fetch overview text
        let overview: CourseOverview | null = null;
        try {
          overview = await apiClient.get<CourseOverview>(
            apiClient.le(courseId, "/overview"),
            { ttl: DEFAULT_CACHE_TTLS.courseContent }
          );
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            return toolResponse({
              courseId,
              description: null,
              hasAttachment: false,
              message: "No syllabus/overview found for this course.",
            });
          }
          throw error;
        }

        // Convert description HTML to markdown
        const description = overview?.Description?.Html
          ? convertHtmlToMarkdown(overview.Description.Html).markdown
          : null;

        // Always attempt to fetch the attachment so we can extract PDF text
        let attachmentBuffer: Buffer | null = null;
        let attachmentFilename = "syllabus";
        let hasAttachment = false;

        try {
          const response = await apiClient.getRaw(
            apiClient.le(courseId, "/overview/attachment")
          );

          if (response.ok) {
            hasAttachment = true;

            // Check Content-Length before downloading body
            const contentLength = parseInt(
              response.headers.get("Content-Length") ?? "0",
              10
            );
            if (contentLength > MAX_FILE_SIZE) {
              return errorResponse(
                `Attachment too large (${Math.round(contentLength / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
              );
            }

            // Get filename from Content-Disposition header
            const disposition = response.headers.get("Content-Disposition") ?? "";
            const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
            if (match?.[1]) {
              attachmentFilename = match[1].replace(/['"]/g, "");
            }

            // Download body as buffer
            attachmentBuffer = Buffer.from(await response.arrayBuffer());

            if (attachmentBuffer.length > MAX_FILE_SIZE) {
              return errorResponse(
                `Attachment too large (${Math.round(attachmentBuffer.length / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
              );
            }
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            hasAttachment = false;
          } else {
            log("DEBUG", "Could not fetch syllabus attachment", error);
          }
        }

        // Extract text from PDF attachment if available
        let syllabusText: string | null = null;
        let totalPages: number | undefined;
        if (attachmentBuffer && attachmentFilename.toLowerCase().endsWith(".pdf")) {
          const extracted = await extractPdfText(attachmentBuffer);
          if (extracted) {
            syllabusText = extracted.text;
            totalPages = extracted.totalPages;
          }
        }

        // Save to disk if downloadPath provided
        let download: { success: boolean; filePath?: string; fileSize?: number; mimeType?: string; error?: string } | undefined;
        if (downloadPath && attachmentBuffer) {
          try {
            const result = await secureDownload({
              targetDir: downloadPath,
              filename: attachmentFilename,
              data: attachmentBuffer,
            });
            log("INFO", `Syllabus attachment downloaded: ${result.path} (${result.size} bytes)`);
            download = {
              success: true,
              filePath: result.path,
              fileSize: result.size,
              mimeType: result.mime,
            };
          } catch (error) {
            log("ERROR", "Failed to save syllabus attachment", error);
            download = {
              success: false,
              error: "Failed to save attachment to disk.",
            };
          }
        } else if (downloadPath && !attachmentBuffer) {
          download = {
            success: false,
            error: "No attachment found for this course's syllabus.",
          };
        }

        log("INFO", `get_syllabus: Retrieved overview for course ${courseId}`);

        // Build response
        const result: Record<string, unknown> = { courseId, description };

        if (syllabusText) {
          result.syllabusText = syllabusText;
          if (totalPages) result.totalPages = totalPages;
        } else {
          result.hasAttachment = hasAttachment;
        }

        if (download) {
          result.download = download;
        }

        return toolResponse(result);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
