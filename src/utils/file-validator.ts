/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import path from "node:path";
import sanitizeFilename from "sanitize-filename";
import { DownloadError } from "./download-errors.js";

/**
 * file-type reports every OLE2 Compound File Binary container as
 * application/x-cfb. It does not read the CFB directory, so it cannot tell a
 * .doc from a .xls from an .msi. The three legacy Office entries in
 * ALLOWED_MIME_TYPES were therefore unreachable and every legacy Office
 * download failed with a generic error.
 *
 * Allowing application/x-cfb outright is not the fix: .msi installers are the
 * same container, and letting one through under a .doc name is exactly what a
 * magic-byte allowlist exists to prevent. Reconcile against the declared
 * extension instead, which admits the formats the allowlist already intended
 * and still refuses everything else.
 */
// file-type v21 is ESM-only and costs ~50ms; defer the import to first use
// since validateFileType is already async.
let fileTypeFromBufferPromise: Promise<typeof import("file-type").fileTypeFromBuffer> | undefined;
function getFileTypeFromBuffer() {
  if (!fileTypeFromBufferPromise) {
    fileTypeFromBufferPromise = import("file-type").then((m) => m.fileTypeFromBuffer);
  }
  return fileTypeFromBufferPromise;
}

const CFB_MIME = "application/x-cfb";
const CFB_EXTENSION_MIMES: Record<string, string> = {
  ".doc": "application/msword",
  ".dot": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".xlt": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pot": "application/vnd.ms-powerpoint",
  ".pps": "application/vnd.ms-powerpoint",
};

/**
 * Maximum file size for downloads (50 MB).
 * Prevents memory exhaustion from malicious large file requests.
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/**
 * Allowlist of MIME types safe for download.
 * Prevents execution of potentially malicious file types (executables, scripts).
 */
export const ALLOWED_MIME_TYPES: string[] = [
  // Documents
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/msword", // .doc
  "application/vnd.ms-powerpoint", // .ppt
  "application/vnd.ms-excel", // .xls
  // Images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Text
  "text/plain",
  "text/csv",
  "text/html",
  // Data
  "application/json",
  // Archives
  "application/zip",
  "application/x-zip-compressed",
  // Media
  "video/mp4",
  "audio/mpeg",
  "audio/wav",
];

/**
 * Validate and sanitize download path to prevent path traversal attacks.
 *
 * @param baseDir - Base directory where downloads are allowed
 * @param filename - User-provided filename (potentially malicious)
 * @returns Validated absolute path within baseDir
 * @throws Error if path traversal detected
 */
export function validateDownloadPath(
  baseDir: string,
  filename: string
): string {
  // A filename carrying a bare '%' (say "100% Final.doc") makes
  // decodeURIComponent throw URIError. Brightspace supplies these names, so
  // that is remote input, and the raw name is the right fallback.
  let decoded: string;
  try {
    decoded = decodeURIComponent(filename);
  } catch {
    decoded = filename;
  }

  // Sanitize filename (removes path separators, null bytes, etc.)
  const sanitized = sanitizeFilename(decoded);

  if (!sanitized || sanitized.length === 0) {
    throw new DownloadError("badFilename", "Invalid filename after sanitization");
  }

  // Resolve full path
  const fullPath = path.resolve(baseDir, sanitized);
  const resolvedBase = path.resolve(baseDir);

  // Verify resolved path is within base directory
  if (
    !fullPath.startsWith(resolvedBase + path.sep) &&
    fullPath !== resolvedBase
  ) {
    throw new DownloadError("pathTraversal", "Path traversal detected");
  }

  return fullPath;
}

/**
 * Validate file type using magic bytes (not extensions).
 * Prevents MIME type spoofing via filename manipulation.
 *
 * @param buffer - File contents to validate
 * @param allowedTypes - MIME types to allow (defaults to ALLOWED_MIME_TYPES)
 * @returns Detected MIME type and extension
 * @throws Error if file type not allowed
 */
export async function validateFileType(
  buffer: Buffer,
  allowedTypes: string[] = ALLOWED_MIME_TYPES,
  filename?: string
): Promise<{ mime: string; ext: string }> {
  // Try magic byte detection first
  const fileTypeFromBuffer = await getFileTypeFromBuffer();
  const detected = await fileTypeFromBuffer(buffer);

  if (detected) {
    if (detected.mime === CFB_MIME) {
      const ext = filename ? path.extname(filename).toLowerCase() : "";
      const resolved = CFB_EXTENSION_MIMES[ext];
      if (resolved && allowedTypes.includes(resolved)) {
        return { mime: resolved, ext: ext.slice(1) };
      }
      throw new DownloadError(
        "unsupportedType",
        `Compound File Binary with extension '${ext || "none"}' is not an allowed Office format`,
        CFB_MIME
      );
    }
    if (!allowedTypes.includes(detected.mime)) {
      throw new DownloadError(
        "unsupportedType",
        `File type '${detected.mime}' not allowed`,
        detected.mime
      );
    }
    return { mime: detected.mime, ext: detected.ext };
  }

  // Fallback for text-based files with no magic-byte signature: accept if the
  // buffer decodes as UTF-8 (rejecting binaries and NUL bytes), then sniff HTML.
  if (!buffer.includes(0)) {
    let decoded: string | null = null;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      // Invalid UTF-8 — treat as binary.
    }

    if (decoded !== null) {
      const noBom =
        decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
      const head = noBom.trimStart().toLowerCase();
      const isHtml =
        head.startsWith("<!doctype html") || head.startsWith("<html");
      const mime = isHtml ? "text/html" : "text/plain";
      const ext = isHtml ? "html" : "txt";

      if (allowedTypes.includes(mime)) {
        return { mime, ext };
      }
    }
  }

  throw new DownloadError(
    "undetectableType",
    "Could not determine file type or type not allowed"
  );
}

/**
 * Validate content ID is a positive integer.
 * Prevents injection via string-based IDs.
 *
 * @param id - User-provided content ID
 * @returns Validated numeric ID
 * @throws Error if ID is not a positive integer
 */
export function validateContentId(id: unknown): number {
  if (typeof id !== "number") {
    throw new Error("Content ID must be a number");
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Content ID must be a positive integer");
  }
  return id;
}

/**
 * Validate URL starts with expected D2L base URL.
 * Prevents SSRF attacks via user-controlled URLs.
 *
 * @param url - URL to validate
 * @param expectedBaseUrl - Expected D2L base URL (e.g., "https://purdue.brightspace.com")
 * @throws Error if URL doesn't match expected base
 */
export function validateBaseUrl(url: string, expectedBaseUrl: string): void {
  if (!url.startsWith(expectedBaseUrl)) {
    throw new Error(
      `URL must start with ${expectedBaseUrl}, got: ${url.substring(0, 50)}...`
    );
  }
}
