/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { AuthError } from "../utils/errors.js";

// Base class for all HTTP API errors
export class ApiError extends AuthError {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
    public readonly responseBody?: string,
    cause?: Error,
  ) {
    super(`[PBMCP-2001] API error (${status}) at ${endpoint}: ${message}`, cause);
    this.name = "ApiError";
  }
}

/**
 * A 401 for a credential pasted into the environment (D2L_ACCESS_TOKEN or
 * D2L_SESSION_COOKIE). No browser sign-in stands behind it, so the user is
 * told how to replace the credential rather than to run the auth command.
 */
export class CredentialRejectedError extends ApiError {
  constructor(endpoint: string, public readonly guidance: string) {
    super(401, endpoint, guidance);
    this.name = "CredentialRejectedError";
  }
}

// Generic HTTP error (non-401/429) - semantic alias for ApiError
export class HttpError extends ApiError {
  constructor(
    status: number,
    endpoint: string,
    message: string,
    responseBody?: string,
    cause?: Error,
  ) {
    super(status, endpoint, message, responseBody, cause);
    this.name = "HttpError";
  }
}

// Rate limit error (429 Too Many Requests)
export class RateLimitError extends ApiError {
  constructor(
    endpoint: string,
    public readonly retryAfter?: number, // seconds
  ) {
    const message = retryAfter
      ? `[PBMCP-2002] Rate limited, retry after ${retryAfter}s`
      : "[PBMCP-2002] Rate limited";
    super(429, endpoint, message);
    this.name = "RateLimitError";
  }
}

// Network-level error (no HTTP status code)
// For fetch failures, timeouts, DNS errors
export class NetworkError extends AuthError {
  constructor(message: string, cause?: Error) {
    super(`[PBMCP-2003] Network error: ${message}`, cause);
    this.name = "NetworkError";
  }
}

/** A temporary token-mint failure must never start browser authentication. */
export class TokenRefreshError extends NetworkError {
  constructor(detail: string, cause?: Error) {
    super(`Token refresh is temporarily unavailable: ${detail}. Your saved session was retained. Try again later.`, cause);
    this.name = "TokenRefreshError";
  }
}
