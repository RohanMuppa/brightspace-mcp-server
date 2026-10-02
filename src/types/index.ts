/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Token data captured from browser interception
export interface TokenData {
  accessToken: string;
  /** Exact HTTPS school origin. Missing only on legacy sessions awaiting validation. */
  tenantOrigin?: string;
  capturedAt: number; // Unix timestamp ms
  expiresAt: number; // Unix timestamp ms
  /** "env" is a pasted D2L_SESSION_COOKIE or D2L_ACCESS_TOKEN; never persisted to disk. */
  source: "browser" | "cache" | "env";
  /**
   * "d2lSessionVal=...; d2lSecureSessionVal=...", harvested at login.
   * Present only when both cookies were found. With csrfToken it lets the
   * token manager mint a fresh JWT instead of relaunching the browser.
   * Also set, with no csrfToken, when D2L_SESSION_COOKIE supplies the pair
   * directly — that cookie is then used as-is (see buildAuthHeaders'
   * "cookie:" prefix), never minted, since minting needs a CSRF token only a
   * live browser page can produce.
   */
  cookieHeader?: string;
  /** D2L XSRF token; the mint answers 403 without it. */
  csrfToken?: string;
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
  /** Configured local root containing separate per-school/account session directories. */
  sessionRoot?: string;
  /** This run verified encrypted legacy browser state before optional profile retirement. */
  legacyBrowserStateMigrated?: boolean;
  tokenTtl: number; // seconds
  headless: boolean;
  /** Tick Microsoft Entra's "Don't ask again" box on the MFA page. Opt-in via D2L_REMEMBER_MFA=true; off by default. */
  rememberMfa?: boolean;
  username?: string;
  password?: string;
  /** Campus within a shared multi-campus Brightspace instance. */
  campus?: string;
  /**
   * Pre-issued Bearer token from D2L_ACCESS_TOKEN. When set, it is used
   * directly on every request and no browser or auth-cli is ever launched.
   * Takes precedence over envSessionCookie.
   */
  envAccessToken?: string;
  /**
   * Normalized "d2lSessionVal=...; d2lSecureSessionVal=..." cookie header
   * from D2L_SESSION_COOKIE. When set (and envAccessToken is not), it is sent
   * as-is on every request and no browser or auth-cli is ever launched.
   */
  envSessionCookie?: string;
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
