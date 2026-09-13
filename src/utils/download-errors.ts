/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Typed download failures.
 *
 * A download that failed validation used to throw a plain Error, which
 * sanitizeError has no branch for, so every one of them reached the user as
 * "An unexpected error occurred. Please try again." That is the least useful
 * sentence available, and it hid a real bug for as long as the tool has
 * existed: no legacy Office file could ever be downloaded.
 *
 * The guidance keyed off `kind` follows the same contract as the auth table:
 * the text is chosen from a closed set this package controls, never built from
 * a caught message. That matters here more than on the auth path, because a
 * download error message can embed a MIME type and a filename that both
 * originate from remote HTTP headers or remote file bytes.
 */

/** Closed set of ways a download can fail before the bytes reach disk. */
export type DownloadFailureKind =
  | "unsupportedType"
  | "undetectableType"
  | "badFilename"
  | "pathTraversal";

export class DownloadError extends Error {
  constructor(
    public readonly kind: DownloadFailureKind,
    message: string,
    /**
     * One short fact worth showing the user, currently only a detected MIME
     * type. Rendered only after isSafeDetail approves it, so a crafted
     * Content-Disposition header or file body cannot put prose in a response.
     */
    public readonly detail?: string
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

/**
 * True only for something shaped like a bare MIME type.
 *
 * This is the narrowest shape that still answers "what actually went wrong",
 * and it admits no spaces, so no free text, path, or response body can pass.
 */
export function isSafeDetail(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(value);
}
