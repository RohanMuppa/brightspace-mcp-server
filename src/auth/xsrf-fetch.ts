/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT: see LICENSE file for details.
 */

import { log } from "../utils/logger.js";

/** Same marker token-mint.ts keys on: a dead session gets a 200 redirect stub. */
const EXPIRED_MARKER = "/d2l/login?sessionExpired=1";

/** Same identity the API client sends, see buildAuthHeaders in api/client.ts. */
const USER_AGENT =
  "BrightspaceMCP/1.0 (Rohan Muppa; github.com/rohanmuppa/brightspace-mcp-server)";

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Where a Brightspace page carries its XSRF token, most specific first.
 *
 * The browser path reads D2L.LP.Web.Authentication.Xsrf.GetXsrfToken(), whose
 * value is the one the page also writes to localStorage as "XSRF.Token"
 * (the same 32 characters). Measured against purdue.brightspace.com: the
 * cookie-only HTML carries it in an inline
 * `localStorage.setItem('XSRF.Token','...')`, so that is the first place to
 * look; the meta tag is the browser path's own fallback.
 */
const XSRF_PATTERNS: readonly RegExp[] = [
  /XSRF\.Token\\?["']\s*,\s*\\?["']([A-Za-z0-9_-]{16,})\\?["']/,
  /<meta[^>]*name=["']d2l-xsrf-token["'][^>]*content=["']([A-Za-z0-9_-]{16,})["']/i,
  /<meta[^>]*content=["']([A-Za-z0-9_-]{16,})["'][^>]*name=["']d2l-xsrf-token["']/i,
];

export interface XsrfFetchOptions {
  /** Tenant base URL, with or without a trailing slash. */
  baseUrl: string;
  /** "d2lSessionVal=...; d2lSecureSessionVal=..." */
  cookieHeader: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type XsrfFetchResult =
  | { ok: true; csrfToken: string }
  | { ok: false; reason: "sessionExpired" | "notFound" | "transport"; detail?: string };

/** Pull the XSRF token out of a Brightspace page's HTML, or null when absent. */
export function parseXsrfToken(html: string): string | null {
  for (const pattern of XSRF_PATTERNS) {
    const match = pattern.exec(html);
    if (match) return match[1];
  }
  return null;
}

/**
 * Read the XSRF token the token mint needs from /d2l/home over plain HTTP,
 * using only the session cookies. This is what lets a pasted
 * D2L_SESSION_COOKIE be traded for a Bearer JWT without a browser.
 */
export async function fetchXsrfToken({
  baseUrl,
  cookieHeader,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: XsrfFetchOptions): Promise<XsrfFetchResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/d2l/home`;

  let status: number;
  let body: string;
  let location: string | null;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { cookie: cookieHeader, "User-Agent": USER_AGENT, accept: "text/html" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    status = response.status;
    body = await response.text();
    location = response.headers?.get("location") ?? null;
  } catch (error) {
    return { ok: false, reason: "transport", detail: error instanceof Error ? error.message : String(error) };
  }

  if (status >= 500 || status === 429) return { ok: false, reason: "transport", detail: `HTTP ${status}` };

  // A dead session either redirects to the login page or answers 200 with the
  // redirect stub. Either way the cookie is no good for minting.
  if (status === 401 || body.includes(EXPIRED_MARKER) || (status >= 300 && status < 400 && location?.includes("/d2l/login"))) {
    log("DEBUG", "The home page answered as a signed-out session");
    return { ok: false, reason: "sessionExpired" };
  }

  if (status < 200 || status >= 300) return { ok: false, reason: "transport", detail: `HTTP ${status}` };

  const csrfToken = parseXsrfToken(body);
  if (!csrfToken) {
    log("DEBUG", "No XSRF token found in the home page HTML");
    return { ok: false, reason: "notFound" };
  }
  return { ok: true, csrfToken };
}
