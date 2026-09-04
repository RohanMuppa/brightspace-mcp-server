/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { TokenData } from "../types/index.js";
import type { TokenManager } from "../auth/token-manager.js";
import type { RetryConfig } from "./retry.js";

// D2L API version information returned by /d2l/api/versions/
export interface ApiVersions {
  lp: string; // Learning Platform version (e.g., "1.56")
  le: string; // Learning Environment version (e.g., "1.91")
}

// Cache TTL configuration in milliseconds
export interface CacheTTLs {
  enrollments: number; // ms - 1 hour (3_600_000) per user decision
  courseContent: number; // ms - 30 min (1_800_000)
  announcements: number; // ms - 5 min (300_000)
  grades: number; // ms - 2 min (120_000)
  assignments: number; // ms - 10 min (600_000)
  roster: number; // ms - 1 hour (3_600_000)
  profile: number; // ms - 1 hour (3_600_000)
}

// Default TTL values per user decision
export const DEFAULT_CACHE_TTLS: CacheTTLs = {
  enrollments: 3_600_000, // 1 hour
  courseContent: 1_800_000, // 30 min
  announcements: 300_000, // 5 min
  grades: 120_000, // 2 min
  assignments: 600_000, // 10 min
  roster: 3_600_000, // 1 hour
  profile: 3_600_000, // 1 hour
};

// Token bucket rate limiter configuration
export interface RateLimitConfig {
  capacity: number; // max burst size (e.g., 10)
  refillRate: number; // tokens per second (e.g., 3)
}

// D2L API client constructor options
export interface D2LApiClientOptions {
  baseUrl: string;
  tokenManager: TokenManager; // from auth module
  cacheTTLs?: Partial<CacheTTLs>;
  rateLimitConfig?: RateLimitConfig;
  timeoutMs?: number; // default 30_000
  /** Called when auth is expired and retries are exhausted. Return true if re-auth succeeded. */
  onAuthExpired?: () => Promise<boolean>;
  /** Backoff for 429, 5xx, and network failures. See retry.ts for defaults. */
  retry?: RetryConfig;
}

// Re-export TokenData from shared types for convenience
export type { TokenData };
