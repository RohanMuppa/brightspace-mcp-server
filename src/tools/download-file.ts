/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { D2LApiClient, ApiError } from "../api/index.js";
import { DownloadFileSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse, withUpdateNotice } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { checkTopicAvailability } from "./topic-availability.js";
// Path containment checks belong to secureStreamDownload, which disk-mode downloads
// go through; importing it here only made it look as though this file
// validated anything itself. Inline mode never writes to disk, so it calls
// validateFileType directly to enforce the same magic-byte allowlist.
import {
  validateContentId,
  validateFileType,
  MAX_FILE_SIZE,
  DISK_MAX_FILE_SIZE,
} from "../utils/file-validator.js";
import { secureStreamDownload, readBodyCapped } from "../utils/download-helpers.js";
import { DownloadError } from "../utils/download-errors.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { officeDocumentText } from "../utils/zip-extract.js";
import fs from "node:fs/promises";
import path from "node:path";

/** The size cap for a download: inline mode buffers the file, disk mode streams it. */
function maxFileSize(downloadPath: string | undefined): number {
  return downloadPath === undefined ? MAX_FILE_SIZE : DISK_MAX_FILE_SIZE;
}

/** The refusal for a file over its mode's cap, pointing inline callers at disk mode. */
function tooLargeResponse(bytes: number | null, downloadPath: string | undefined): CallToolResult {
  const hint =
    downloadPath === undefined
      ? " Provide an absolute downloadPath to save it to disk instead."
      : "";
  // null: the body was cut off at the cap, so its full size is unknown.
  const size = bytes === null ? "over the limit" : `${Math.round(bytes / 1024 / 1024)}MB`;
  return errorResponse(
    `File too large (${size}). Maximum allowed: ${maxFileSize(downloadPath) / 1024 / 1024}MB.${hint}`
  );
}

/**
 * Maximum bytes of a file we'll embed inline in a tool response. Base64
 * encoding (for images) adds ~33% overhead, so this stays well under typical
 * MCP response-size limits. A file over this cap still works — the caller
 * just needs to pass an absolute `downloadPath` to save it to disk instead.
 */
const INLINE_MAX_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Maximum bytes of an image specifically that we'll embed inline as an MCP
 * ImageContent block. Base64 encoding adds ~33% overhead, so a file right up
 * against INLINE_MAX_SIZE (10 MB) would base64-encode to ~13.6 MB — comfortably
 * over the model API's ~5 MB per-image limit, which fails the *entire* tool
 * response, not just the image block. A tighter cap here (3.5 MB raw, ~4.7 MB
 * base64) keeps every inlined image under that limit; a larger image falls
 * through to the binary_description_only branch with a note to use
 * downloadPath instead.
 */
const INLINE_IMAGE_MAX_SIZE = 3.5 * 1024 * 1024; // 3.5 MB

/**
 * Maximum characters of extracted text (PDF, Office document, or plain text)
 * inlined into a single tool response. ~400,000 characters is roughly 100k
 * tokens — enough for most course documents — and a hard cap keeps one
 * runaway file from dominating the conversation.
 */
const INLINE_TEXT_MAX_CHARS = 400_000;

/**
 * MCP ImageContent blocks are passed to Anthropic's vision pipeline, which
 * accepts JPEG, PNG, GIF, and WebP. Any other image mime (SVG, BMP, TIFF)
 * falls back to the generic "can't display inline" path below.
 */
const INLINE_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** OOXML formats `officeDocumentText` (zip-extract.ts) knows how to read. */
const INLINE_OFFICE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
]);

/** Mime types whose bytes are safe to decode as UTF-8 and inline verbatim. */
const INLINE_TEXT_MIMES = new Set(["text/plain", "text/csv", "text/html", "application/json"]);

/** Truncate text to `max` characters, noting how much was cut and why. */
function truncateForInline(text: string, max: number): { body: string; truncated: boolean } {
  if (text.length <= max) return { body: text, truncated: false };
  const remaining = text.length - max;
  return {
    body:
      text.slice(0, max) +
      `\n\n[...truncated at ${max} characters; ${remaining} more characters exist in the source file. ` +
      "Re-run with an absolute downloadPath to save the full file to disk instead...]",
    truncated: true,
  };
}

/**
 * Inline mode: return the file directly in the tool response instead of
 * writing it to disk. This is the right mode inside clients like Claude
 * Desktop, where the MCP server's host filesystem is not the same filesystem
 * its analysis/sandbox tools see — a file `download_file` wrote to disk there
 * was simply unreachable from the rest of the conversation.
 *
 * Deliberately emits only TextContent and, for a handful of image mimes,
 * ImageContent — never an MCP EmbeddedResource. Claude Desktop feeds an
 * EmbeddedResource with mimeType `application/pdf` into Anthropic's document
 * pipeline, which rejects PDFs containing JBIG2-compressed images (common in
 * scanned academic PDFs) and can fail the *entire* tool response, even next
 * to perfectly good TextContent blocks. Extracted text sidesteps that
 * pipeline entirely. (Adapted from LunaParker/brightspace-mcp-server, MIT.)
 */
async function respondInline(
  buffer: Buffer,
  originalFilename: string,
  customFilename: string | undefined
): Promise<CallToolResult> {
  const effectiveFilename = customFilename || originalFilename;

  if (buffer.length > INLINE_MAX_SIZE) {
    return errorResponse(
      `File too large for inline delivery (${Math.round(buffer.length / 1024 / 1024)}MB, inline max ${INLINE_MAX_SIZE / 1024 / 1024}MB). Provide an absolute downloadPath to save it to disk instead.`
    );
  }

  // Enforces the same magic-byte allowlist as disk mode (secureStreamDownload calls
  // validateFileTypeOfFile internally); inline mode never writes to disk, so it has
  // to call this itself. Throws DownloadError on an unsupported or
  // undetectable type, handled by the caller's sanitizeError.
  const { mime } = await validateFileType(buffer, undefined, effectiveFilename);

  const metadata: Record<string, unknown> = {
    mode: "inline",
    filename: effectiveFilename,
    originalFilename,
    mimeType: mime,
    size: buffer.length,
  };

  const content: CallToolResult["content"] = [];

  if (mime === "application/pdf") {
    const extracted = await extractPdfText(buffer);
    if (!extracted || !extracted.text) {
      metadata.representation = "pdf_text_extraction_failed";
      metadata.note =
        "No text layer found in this PDF (it may be a scan). Re-run with an absolute downloadPath to save the raw file to disk.";
      content.push({ type: "text", text: JSON.stringify(metadata) });
      return withUpdateNotice(content);
    }
    const { body, truncated } = truncateForInline(extracted.text, INLINE_TEXT_MAX_CHARS);
    metadata.representation = "extracted_text";
    metadata.pages = extracted.totalPages;
    metadata.truncated = truncated;
    content.push({ type: "text", text: JSON.stringify(metadata) });
    content.push({
      type: "text",
      text: `--- Extracted PDF text (${extracted.totalPages} page${extracted.totalPages === 1 ? "" : "s"})${truncated ? ", truncated" : ""} ---\n${body}`,
    });
  } else if (INLINE_IMAGE_MIMES.has(mime)) {
    if (buffer.length > INLINE_IMAGE_MAX_SIZE) {
      // Base64-encoding a file this size would exceed the model API's image
      // limit and fail the whole response, so this falls back to the same
      // "can't display inline" path as an unsupported binary format rather
      // than emitting an oversized ImageContent block.
      metadata.representation = "binary_description_only";
      metadata.note = `This image is too large to inline (${Math.round(buffer.length / 1024 / 1024)}MB, inline image max ${INLINE_IMAGE_MAX_SIZE / 1024 / 1024}MB). Re-run download_file with an absolute downloadPath to save it to disk instead.`;
      content.push({ type: "text", text: JSON.stringify(metadata) });
      return withUpdateNotice(content);
    }
    metadata.representation = "image";
    content.push({ type: "text", text: JSON.stringify(metadata) });
    content.push({ type: "image", data: buffer.toString("base64"), mimeType: mime });
  } else if (INLINE_OFFICE_MIMES.has(mime)) {
    // Reuses the same zip-based text extraction get_assignment_files and
    // get_announcement_files already rely on (attachment-reader.ts) rather
    // than duplicating it here.
    const text = officeDocumentText(buffer);
    if (!text) {
      metadata.representation = "office_text_extraction_failed";
      metadata.note =
        "No readable text found in this Office document. Re-run with an absolute downloadPath to save the raw file to disk.";
      content.push({ type: "text", text: JSON.stringify(metadata) });
      return withUpdateNotice(content);
    }
    const { body, truncated } = truncateForInline(text, INLINE_TEXT_MAX_CHARS);
    metadata.representation = "extracted_text";
    metadata.truncated = truncated;
    content.push({ type: "text", text: JSON.stringify(metadata) });
    content.push({ type: "text", text: `--- Extracted text (${effectiveFilename}) ---\n${body}` });
  } else if (INLINE_TEXT_MIMES.has(mime)) {
    const raw = buffer.toString("utf-8");
    const { body, truncated } = truncateForInline(raw, INLINE_TEXT_MAX_CHARS);
    metadata.representation = "text";
    metadata.truncated = truncated;
    content.push({ type: "text", text: JSON.stringify(metadata) });
    content.push({ type: "text", text: `--- File contents (${effectiveFilename}) ---\n${body}` });
  } else {
    // Binary formats we can't meaningfully show in the conversation (zip,
    // legacy .doc/.ppt/.xls, video, audio, svg, ...). Emitting an
    // EmbeddedResource here would put us back in the PDF-rejection failure
    // mode described above, so this just points the caller at disk mode.
    metadata.representation = "binary_description_only";
    metadata.note = `This file type (${mime}) cannot be displayed inline. Re-run download_file with an absolute downloadPath to save it to disk instead.`;
    content.push({ type: "text", text: JSON.stringify(metadata) });
  }

  return withUpdateNotice(content);
}

/**
 * Finish a download once the response is in hand: stream it to disk when
 * `downloadPath` is given (unchanged response shape, plus a new `mode: "disk"`
 * field), otherwise buffer it and return the file inline in the tool response.
 */
async function finishDownload(
  response: Response,
  originalFilename: string,
  downloadPath: string | undefined,
  customFilename: string | undefined,
  sourceLabel: string
): Promise<CallToolResult> {
  // Check Content-Length BEFORE reading the body (prevent memory exhaustion)
  const contentLength = parseInt(response.headers.get("Content-Length") ?? "0", 10);
  if (contentLength > maxFileSize(downloadPath)) {
    return tooLargeResponse(contentLength, downloadPath);
  }

  if (downloadPath === undefined) {
    // Content-Length can be missing or understated, so the read itself is
    // capped and stops at the limit rather than buffering the whole body.
    let buffer: Buffer;
    try {
      buffer = await readBodyCapped(response, MAX_FILE_SIZE);
    } catch (error) {
      if (error instanceof DownloadError && error.kind === "tooLarge") {
        return tooLargeResponse(null, downloadPath);
      }
      throw error;
    }
    return respondInline(buffer, originalFilename, customFilename);
  }

  const effectiveFilename = customFilename || originalFilename;

  if (!response.body) {
    throw new DownloadError("undetectableType", "File is empty (0 bytes)");
  }

  // Streams to disk with path traversal prevention, file type validation,
  // conflict resolution, and the disk size cap
  const result = await secureStreamDownload({
    targetDir: downloadPath,
    filename: effectiveFilename,
    body: response.body,
    maxBytes: DISK_MAX_FILE_SIZE,
  });

  log(
    "INFO",
    `${sourceLabel} downloaded successfully: ${result.path} (${result.size} bytes, ${result.mime})`
  );

  return toolResponse({
    mode: "disk",
    success: true,
    filePath: result.path,
    fileSize: result.size,
    mimeType: result.mime,
    originalFilename,
    message: `File downloaded successfully to ${result.path}`,
  });
}

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
        "Download a file from course content, assignment submissions, or an announcement's attachments. Use this when the user wants a file from Brightspace course content, dropbox submissions, or an announcement (newsId + fileId, from get_announcements). Two response modes: (1) INLINE (default — omit downloadPath): the file comes back directly in the tool response — extracted text for PDFs and Office documents, an image block for jpeg/png/gif/webp, or a short description for anything else — so it can be read immediately without touching any filesystem. This is the right choice in clients like Claude Desktop, whose analysis/sandbox tools cannot see a file the MCP server writes to its own host filesystem. (2) DISK (set downloadPath to an absolute path on the HOST filesystem the MCP server runs on): the file is saved there. Ask the user where to save it before using disk mode — never guess a directory. After identifying the file, suggest a clean readable filename (e.g., 'Lecture 7 - Memory Management.pdf' instead of 'L07_CS251_2026SP_v2.pdf') and pass it as customFilename, or omit it to keep the original. If a content-topic download fails because the file isn't released yet, the response explains why when Brightspace's module/topic metadata supports it (not yet open, ended, locked, or hidden).",
      inputSchema: DownloadFileSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "download_file tool called", { args });

        // Parse and validate input
        const { courseId, topicId, folderId, newsId, fileId, downloadPath, customFilename } =
          DownloadFileSchema.parse(args);

        // Validate courseId
        validateContentId(courseId);

        // downloadPath is optional: omitting it means "return the file
        // inline" (see respondInline), so there is nothing on the host
        // filesystem to validate in that case.
        if (downloadPath !== undefined) {
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
        } else if (newsId !== undefined && fileId !== undefined) {
          // Announcement attachment download
          validateContentId(newsId);
          validateContentId(fileId);
          return await downloadNewsAttachment(
            apiClient,
            courseId,
            newsId,
            fileId,
            downloadPath,
            customFilename
          );
        } else {
          return errorResponse(
            "Either topicId (for content files), both folderId and fileId (for submission files), or both newsId and fileId (for announcement attachments) must be provided"
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
  downloadPath: string | undefined,
  customFilename?: string
): Promise<any> {
  log(
    "INFO",
    `Downloading content file: courseId=${courseId}, topicId=${topicId}`
  );

  // Build download URL using D2L API path helper
  const apiPath = apiClient.le(courseId, `/content/topics/${topicId}/file`);

  // Unreleased files can return 404 as well as 403. Only explain a release
  // restriction when the metadata supports it; keep other failures intact.
  let response: Response;
  try {
    response = await apiClient.getRaw(apiPath);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      const unavailable = await checkTopicAvailability(apiClient, courseId, topicId, error.status);
      if (unavailable) return toolResponse(unavailable);
    }
    throw error;
  }

  // Get filename from Content-Disposition header
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = parseContentDispositionFilename(disposition) ?? "download";

  log("DEBUG", `Content-Disposition filename: ${filename}`);

  const originalFilename = filename;

  return finishDownload(response, originalFilename, downloadPath, customFilename, "Content file");
}

/**
 * Download a submission/feedback file using folderId + fileId
 */
async function downloadSubmissionFile(
  apiClient: D2LApiClient,
  courseId: number,
  folderId: number,
  fileId: number,
  downloadPath: string | undefined,
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
  if (file.Size > maxFileSize(downloadPath)) {
    return tooLargeResponse(file.Size, downloadPath);
  }

  // D2L file download URL pattern for submission files
  // GET /d2l/api/le/(version)/(orgUnitId)/dropbox/folders/(folderId)/submissions/(submissionId)/files/(fileId)/download
  const downloadApiPath = apiClient.le(
    courseId,
    `/dropbox/folders/${folderId}/submissions/${submission.Id}/files/${fileId}/download`
  );

  // Fetch file
  const response = await apiClient.getRaw(downloadApiPath);

  const originalFilename = file.FileName;

  return finishDownload(response, originalFilename, downloadPath, customFilename, "Submission file");
}

/**
 * Download an announcement attachment using newsId + fileId
 */
async function downloadNewsAttachment(
  apiClient: D2LApiClient,
  courseId: number,
  newsId: number,
  fileId: number,
  downloadPath: string | undefined,
  customFilename?: string
): Promise<any> {
  log(
    "INFO",
    `Downloading announcement attachment: courseId=${courseId}, newsId=${newsId}, fileId=${fileId}`
  );

  // The news item lists its attachments, so an unknown fileId can name the
  // real ones and an oversize file is refused before a byte is fetched.
  interface NewsItem {
    Attachments?: Array<{
      FileId: number;
      FileName: string;
      Size: number;
    }> | null;
  }

  const newsItem = await apiClient.get<NewsItem>(
    apiClient.le(courseId, `/news/${newsId}`)
  );
  const attachments = newsItem?.Attachments ?? [];
  const file = attachments.find((f) => f.FileId === fileId);

  if (!file) {
    return errorResponse(
      `File ID ${fileId} not found on this announcement. Available files: ${attachments.map((f) => `${f.FileName} (ID: ${f.FileId})`).join(", ")}`
    );
  }

  if (file.Size > maxFileSize(downloadPath)) {
    return tooLargeResponse(file.Size, downloadPath);
  }

  // GET /d2l/api/le/(version)/(orgUnitId)/news/(newsItemId)/attachments/(fileId)
  const response = await apiClient.getRaw(
    apiClient.le(courseId, `/news/${newsId}/attachments/${fileId}`)
  );

  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = parseContentDispositionFilename(disposition) ?? file.FileName;

  const originalFilename = filename;

  return finishDownload(response, originalFilename, downloadPath, customFilename, "Announcement attachment");
}
