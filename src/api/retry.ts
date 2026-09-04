/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import { ApiError, NetworkError, RateLimitError } from "./errors.js";

/**
 * Retry transient failures with exponential backoff and jitter.
 *
 * What counts as transient is decided by the caller through `shouldRetry`,
 * so this module knows nothing about HTTP. A 429 that names a Retry-After is
 * honored verbatim, even past `maxMs`, because the server has told us
 * exactly when to come back and guessing sooner only earns another 429.
 *
 * `sleep` and `jitter` are injectable so the backoff sequence is testable
 * without fake timers.
 */

export interface RetryConfig {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Backoff before the second attempt, doubled thereafter. Default 250. */
  initialMs?: number;
  /** Ceiling on the computed backoff. Default 5000. Retry-After ignores it. */
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1). Default Math.random. */
  jitter?: () => number;
}

export interface RetryOptions extends RetryConfig {
  shouldRetry: (error: unknown) => boolean;
  /** Milliseconds the failure itself asked us to wait, if it did. */
  retryAfterMs?: (error: unknown) => number | undefined;
}

const JITTER_FRACTION = 0.3;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxAttempts = 3,
    initialMs = 250,
    maxMs = 5000,
    sleep = defaultSleep,
    jitter = Math.random,
    shouldRetry,
    retryAfterMs,
  } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;

      const requested = retryAfterMs?.(error);
      let delay: number;
      if (requested !== undefined) {
        delay = requested;
      } else {
        const base = Math.min(initialMs * 2 ** (attempt - 1), maxMs);
        delay = Math.round(base + base * JITTER_FRACTION * jitter());
      }
      await sleep(delay);
    }
  }
}

/**
 * Exactly three things get better by waiting: a rate limit, a server-side
 * failure, and a dropped connection. A 401 needs a new token, a 403 needs
 * permission, a 404 needs a different path. None of those are retried.
 */
export function isRetryableFailure(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof ApiError) return error.status >= 500 && error.status <= 599;
  return error instanceof NetworkError;
}

/** The Retry-After a 429 carried, in milliseconds, or undefined. */
export function retryAfterMsFrom(error: unknown): number | undefined {
  if (error instanceof RateLimitError && typeof error.retryAfter === "number" && error.retryAfter > 0) {
    return error.retryAfter * 1000;
  }
  return undefined;
}
