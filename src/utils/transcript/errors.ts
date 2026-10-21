/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/** The video exists and answered, but has no captions — an expected outcome, not a failure. */
export class NoTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoTranscriptError";
  }
}

/**
 * Why a transcript could not be read, for callers that act on it rather than
 * read the message: a sign-in or bot check needs a person in a browser, an
 * unavailable video needs nothing, and anything else may pass on a retry.
 */
export type TranscriptFailureReason = "sign_in_required" | "access_blocked" | "unavailable" | "fetch_failed";

/** The platform's API could not be reached or rejected the request. */
export class TranscriptFetchError extends Error {
  constructor(
    message: string,
    readonly reason: TranscriptFailureReason = "fetch_failed",
  ) {
    super(message);
    this.name = "TranscriptFetchError";
  }
}
