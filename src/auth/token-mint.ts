/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT: see LICENSE file for details.
 */

import { log } from "../utils/logger.js";
import { devActivity } from "../utils/dev-activity.js";

/**
 * The marker in the HTML stub a dead session gets instead of a token payload.
 * Measured against purdue.brightspace.com: an expired session answers HTTP 200
 * carrying a script that redirects to /d2l/login?sessionExpired=1. There is no
 * 401 on this path, so the marker, not the status, is the only honest signal.
 */
const EXPIRED_MARKER = "/d2l/login?sessionExpired=1";

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

function expiredRedirect(location: string | null, tokenUrl: string): boolean {
  if (!location) return false;
  try {
    const target = new URL(location, tokenUrl);
    return target.origin === new URL(tokenUrl).origin &&
      target.pathname === "/d2l/login" && target.searchParams.get("sessionExpired") === "1";
  } catch {
    return false;
  }
}

/**
 * Exchange the D2L session cookies for a fresh Bearer token in one request.
 * This is the cheap alternative to relaunching Chromium when the JWT expires.
 *
 * Only a 401 or the known login redirect proves session expiry. Server errors,
 * permission failures and unknown response formats remain temporary failures.
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
  let location: string | null;
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
      redirect: "manual",
    });
    status = response.status;
    body = await response.text();
    location = response.headers?.get("location") ?? null;
  } catch (error) {
    devActivity("token_mint_response", { outcome: "transport", reason: "transport" });
    const message = error instanceof Error ? error.message : String(error);
    return transport(message);
  }

  if (status >= 500 || status === 429) {
    devActivity("token_mint_response", { status, outcome: "transport", reason: "serviceUnavailable" });
    return transport(`HTTP ${status}`);
  }

  let payload: { access_token?: unknown } | null = null;
  try {
    payload = JSON.parse(body) as { access_token?: unknown } | null;
  } catch {
    // The known expired-session response is an HTML login redirect.
  }

  if (status === 401 || (!payload && body.includes(EXPIRED_MARKER)) ||
      expiredRedirect(location, url)) {
    devActivity("token_mint_response", { status, outcome: "sessionExpired",
      reason: status === 401 ? "http401" : expiredRedirect(location, url) ? "expiredRedirect" : "expiredStub" });
    log("DEBUG", "The token mint answered with the session-expired stub");
    return { ok: false, reason: "sessionExpired" };
  }

  if (status < 200 || status >= 300) {
    devActivity("token_mint_response", { status, outcome: "transport", reason: "transport" });
    return transport(`HTTP ${status}`);
  }

  if (!payload) {
    devActivity("token_mint_response", { status, outcome: "transport", reason: "invalidPayload" });
    return transport("the token mint returned an unparseable body");
  }

  const accessToken = payload.access_token;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    devActivity("token_mint_response", { status, outcome: "transport", reason: "invalidPayload" });
    return transport("the token mint returned no access_token");
  }

  devActivity("token_mint_response", { status, outcome: "success" });
  return { ok: true, accessToken };
}
