/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import dotenv from "dotenv";
import type { AppConfig } from "../types/index.js";
import { configStoreExists, getConfigStorePath, loadConfigStore } from "./config-store.js";
import type { ConfigStoreData } from "./config-store.js";
import { resolveStoredPassword } from "./secure-config.js";
import { migrateLegacyState } from "../auth/legacy-state.js";

export async function loadConfig(): Promise<AppConfig> {
  dotenv.config({ quiet: true });

  // A corrupt or permission-denied config.json must not take the whole server
  // down at startup: env vars alone are a complete, if less convenient,
  // configuration. The failure is still surfaced loudly (never silent) so a
  // broken file doesn't masquerade as "no config.json was ever created".
  // Idea from lmgveerhoek's fork (MIT).
  let store: ConfigStoreData | null = null;
  let storeLoadError: unknown;
  if (configStoreExists()) {
    try {
      store = loadConfigStore();
    } catch (error) {
      storeLoadError = error;
    }
  }

  if (store) {
    console.error("[config] Loaded base config from ~/.brightspace-mcp/config.json");
  } else if (storeLoadError) {
    console.error(
      `[config] WARN: Failed to read ${getConfigStorePath()} (${
        storeLoadError instanceof Error ? storeLoadError.message : String(storeLoadError)
      }); ` +
      "continuing with environment variables only."
    );
  } else {
    console.error("[config] No config.json found, using environment variables");
  }

  // Resolve sessionDir: env > store > default
  const sessionRoot = process.env.D2L_SESSION_DIR
    ? expandTilde(process.env.D2L_SESSION_DIR)
    : store?.sessionDir
      ? expandTilde(store.sessionDir)
      : path.join(os.homedir(), ".d2l-session");

  // Code-entry and other interactive MFA methods need a visible browser.
  const headless = envBoolean(process.env.D2L_HEADLESS, "D2L_HEADLESS")
    ?? store?.headless
    ?? true;

  // Opt-in: ask Microsoft to skip the second factor for its "Don't ask again"
  // window. Off unless D2L_REMEMBER_MFA=true, so a shared machine never
  // remembers MFA without the user choosing it.
  const rememberMfa = envBoolean(process.env.D2L_REMEMBER_MFA, "D2L_REMEMBER_MFA") ?? false;

  // Resolve tokenTtl: env > store > default (3600)
  const tokenTtl = positiveSeconds(process.env.D2L_TOKEN_TTL, "D2L_TOKEN_TTL")
    ?? positiveSeconds(store?.tokenTtl, "tokenTtl in config.json")
    ?? 3600;

  // Resolve includeCourseIds: env > store > undefined
  const includeCourseIds = process.env.D2L_INCLUDE_COURSES
    ? process.env.D2L_INCLUDE_COURSES.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : store?.includeCourses;

  // Resolve excludeCourseIds: env > store > undefined
  const excludeCourseIds = process.env.D2L_EXCLUDE_COURSES
    ? process.env.D2L_EXCLUDE_COURSES.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : store?.excludeCourses;

  // Resolve activeOnly: env > store > default (true)
  const activeOnly = envBoolean(process.env.D2L_ACTIVE_ONLY, "D2L_ACTIVE_ONLY")
    ?? store?.activeOnly
    ?? true;

  // D2L_ACCESS_TOKEN beats D2L_SESSION_COOKIE beats the normal stored-credential
  // browser flow; both are validated whenever present regardless of which one
  // wins, so a typo in the losing variable still fails loudly at startup.
  const envAccessToken = readEnvSecret(process.env.D2L_ACCESS_TOKEN, "D2L_ACCESS_TOKEN");
  const rawSessionCookie = readEnvSecret(process.env.D2L_SESSION_COOKIE, "D2L_SESSION_COOKIE");
  const envSessionCookie = rawSessionCookie ? parseSessionCookieEnv(rawSessionCookie) : undefined;

  const configuredUrl = new URL(process.env.D2L_BASE_URL || store?.baseUrl || "https://purdue.brightspace.com");
  if (configuredUrl.protocol !== "https:" || configuredUrl.username || configuredUrl.password) {
    throw new Error("The Brightspace URL must be an HTTPS school URL without embedded credentials.");
  }
  const baseUrl = configuredUrl.origin;
  const username = process.env.D2L_USERNAME || store?.username;
  const password = await resolveStoredPassword(baseUrl, username, store);
  // A new account must never inherit another account's cookies, even at the same school.
  const sessionDir = accountSessionDirectory(sessionRoot, baseUrl, username);
  const legacyMigration = sessionDir !== sessionRoot ? await migrateLegacyState(sessionRoot) : undefined;

  return {
    baseUrl,
    sessionDir,
    sessionRoot,
    legacyBrowserStateMigrated: legacyMigration?.browserState === "encrypted",
    tokenTtl,
    headless,
    rememberMfa,
    username,
    password,
    campus: process.env.D2L_CAMPUS || store?.campus,
    envAccessToken,
    envSessionCookie,
    courseFilter: {
      includeCourseIds,
      excludeCourseIds,
      activeOnly,
    },
  };
}

export function accountSessionDirectory(root: string, baseUrl: string, username?: string): string {
  if (!username) return root;
  const account = createHash("sha256").update(JSON.stringify([new URL(baseUrl).origin, username])).digest("hex");
  return path.join(root, "accounts", account);
}

/**
 * A token lifetime must be a whole, positive number of seconds. NaN, zero, a
 * negative number, or "1h" read as 1 second would all produce a token that is
 * already inside the refresh buffer, so every tool call would mint again.
 */
function positiveSeconds(value: string | number | undefined, source: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text) && Number(text) > 0) return Number(text);
  console.error(`[config] Ignoring ${source}=${JSON.stringify(value)}: expected a positive whole number of seconds`);
  return undefined;
}

/**
 * An on/off environment variable. Comparing against the exact string "false"
 * read "0", "no", "False" and a typo as true, so D2L_HEADLESS=0 kept the
 * browser hidden from a user who needed it to enter an MFA code. An empty
 * value counts as unset, and anything unrecognized is ignored with a warning
 * so config.json or the default applies, as positiveSeconds does.
 */
function envBoolean(value: string | undefined, source: string): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) return undefined;
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  console.error(`[config] Ignoring ${source}=${JSON.stringify(value)}: expected true or false`);
  return undefined;
}

/** CR, LF, or NUL in a header value enables request smuggling / header injection. */
const CONTROL_CHAR_PATTERN = /[\r\n\0]/;

/**
 * Validate a pasted auth secret (D2L_SESSION_COOKIE or D2L_ACCESS_TOKEN).
 * Unlike positiveSeconds/envBoolean above, a bad value here is never silently
 * ignored: both env vars exist specifically to skip the browser, so a typo
 * must fail loudly at startup rather than fall back to a sign-in flow the
 * user deliberately avoided. Returns undefined only when the variable is
 * genuinely unset (absent or empty), matching the other env helpers' treatment
 * of "".
 *
 * The CR/LF/NUL check is adapted from the injection guard in
 * JhostinAleck/brightspace-mcp (MIT), AccessToken.ts:10-19. Surrounding
 * whitespace is rejected rather than trimmed: a trailing newline or space is
 * exactly the kind of thing a terminal paste or `export FOO=$(cat file)`
 * leaves behind, and silently stripping it would hide the mistake instead of
 * surfacing it.
 */
export function readEnvSecret(value: string | undefined, varName: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (CONTROL_CHAR_PATTERN.test(value)) {
    throw new Error(
      `${varName} contains a carriage return, line feed, or NUL character. Paste the value as a single line with no embedded newlines.`
    );
  }
  if (value !== value.trim()) {
    throw new Error(`${varName} has leading or trailing whitespace. Remove it and try again.`);
  }
  return value;
}

const D2L_SESSION_VAL = "d2lSessionVal";
const D2L_SECURE_SESSION_VAL = "d2lSecureSessionVal";

const SESSION_COOKIE_FORMAT_ERROR =
  'D2L_SESSION_COOKIE must be either "d2lSessionVal=...; d2lSecureSessionVal=..." ' +
  "(the cookie header copied from a logged-in browser) or the two cookie values " +
  "separated by a semicolon, in that order (d2lSessionVal;d2lSecureSessionVal).";

/**
 * Normalize D2L_SESSION_COOKIE into the "d2lSessionVal=...; d2lSecureSessionVal=..."
 * header D2L's API expects. Accepts a full cookie-header fragment (extra
 * cookies alongside the two named ones are ignored, order doesn't matter) or
 * the two raw values separated by a semicolon with no cookie names, in which
 * case the first is d2lSessionVal and the second d2lSecureSessionVal.
 */
export function parseSessionCookieEnv(raw: string): string {
  const segments = raw.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
  const named: Partial<Record<string, string>> = {};
  // The form is decided by whether a segment is NAMED d2lSessionVal/
  // d2lSecureSessionVal (its name before the first "="), not by whether any
  // "=" appears at all -- the two-raw-values form's second value can itself
  // contain "=" (base64 padding), which must not be mistaken for a name.
  let anyNamed = false;
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const name = segment.slice(0, eq).trim();
    if (name === D2L_SESSION_VAL || name === D2L_SECURE_SESSION_VAL) {
      anyNamed = true;
      named[name] = segment.slice(eq + 1).trim();
    }
  }

  if (anyNamed) {
    if (named[D2L_SESSION_VAL] && named[D2L_SECURE_SESSION_VAL]) {
      return `${D2L_SESSION_VAL}=${named[D2L_SESSION_VAL]}; ${D2L_SECURE_SESSION_VAL}=${named[D2L_SECURE_SESSION_VAL]}`;
    }
  } else if (segments.length === 2) {
    const [sessionVal, secureSessionVal] = segments;
    return `${D2L_SESSION_VAL}=${sessionVal}; ${D2L_SECURE_SESSION_VAL}=${secureSessionVal}`;
  }

  throw new Error(SESSION_COOKIE_FORMAT_ERROR);
}

/** Exported for the `doctor` CLI, which resolves the same session directory without loading the full app config. */
export function expandTilde(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export type { AppConfig };
