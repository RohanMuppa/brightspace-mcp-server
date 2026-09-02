/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Token data captured from browser interception
export interface TokenData {
  accessToken: string;
  capturedAt: number; // Unix timestamp ms
  expiresAt: number; // Unix timestamp ms
  source: "browser" | "cache";
}

// Encrypted token stored on disk
export interface EncryptedData {
  iv: string; // hex-encoded initialization vector
  authTag: string; // hex-encoded GCM auth tag
  data: string; // hex-encoded ciphertext
}

// Session file persisted to ~/.d2l-session/
export interface SessionFile {
  version: 1;
  encrypted: EncryptedData;
  createdAt: number; // Unix timestamp ms
  expiresAt: number; // Unix timestamp ms
}

// Application configuration
export interface AppConfig {
  baseUrl: string;
  sessionDir: string;
  tokenTtl: number; // seconds
  headless: boolean;
  username?: string;
  password?: string;
  /** Campus within a shared multi-campus Brightspace instance. */
  campus?: string;
  courseFilter: CourseFilterConfig;
}

// Auth result from browser auth flow
export interface AuthResult {
  token: TokenData;
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }>;
}

// Log levels
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

// Course filtering configuration from environment variables
export interface CourseFilterConfig {
  includeCourseIds?: number[];
  excludeCourseIds?: number[];
  activeOnly: boolean;
}
