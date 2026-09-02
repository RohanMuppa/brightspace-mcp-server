/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT: see LICENSE file for details.
 */

import { log } from "../utils/logger.js";

/**
 * The marker in the HTML stub a dead session gets instead of a token payload.
 * Measured against purdue.brightspace.com: an expired session answers HTTP 200
 * carrying a script that redirects to /d2l/login?sessionExpired=1. There is no
 * 401 on this path, so the marker, not the status, is the only honest signal.
 */
const EXPIRED_MARKER = "sessionExpired=1";

/** Same identity the API client sends, see buildAuthHeaders in api/client.ts. */
const USER_AGENT =
  "BrightspaceMCP/1.0 (Rohan Muppa; github.com/rohanmuppa/brightspace-mcp-server)";

const DEFAULT_TIMEOUT_MS = 15000;

export interface MintOptions {
  /** Tenant base URL, with or without a trailing slash. */
  baseUrl: string;
  /** "d2lSessionVal=...; d2lSecureSessionVal=..." */
  cookieHeader: string;
  /** Without this header the mint answers 403 even with a good cookie. */
  csrfToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type MintResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "sessionExpired" | "transport"; detail?: string };

const transport = (detail: string): MintResult => ({
  ok: false,
  reason: "transport",
  detail,
});

/**
 * Exchange the D2L session cookies for a fresh Bearer token in one request.
 * This is the cheap alternative to relaunching Chromium when the JWT expires.
 *
 * Classification order matters: a network throw is transport, the expiry marker
 * wins over the status code, then a non-2xx status, then a missing access_token.
 */
export async function mintAccessToken({
  baseUrl,
  cookieHeader,
  csrfToken,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: MintOptions): Promise<MintResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/d2l/lp/auth/oauth2/token`;

  let status: number;
  let body: string;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader,
        "x-csrf-token": csrfToken,
        "User-Agent": USER_AGENT,
      },
      body: "scope=*:*:*",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    body = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return transport(message);
  }

  if (body.includes(EXPIRED_MARKER)) {
    log("DEBUG", "The token mint answered with the session-expired stub");
    return { ok: false, reason: "sessionExpired" };
  }

  if (status < 200 || status >= 300) {
    return transport(`HTTP ${status}`);
  }

  let accessToken: unknown;
  try {
    accessToken = (JSON.parse(body) as { access_token?: unknown }).access_token;
  } catch {
    return transport("the token mint returned an unparseable body");
  }

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return transport("the token mint returned no access_token");
  }

  return { ok: true, accessToken };
}
