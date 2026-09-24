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

/** The platform's API could not be reached or rejected the request. */
export class TranscriptFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptFetchError";
  }
}
