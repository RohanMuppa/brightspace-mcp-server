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
import { configStoreExists, loadConfigStore } from "./config-store.js";
import { resolveStoredPassword } from "./secure-config.js";
import { migrateLegacyState } from "../auth/legacy-state.js";

export async function loadConfig(): Promise<AppConfig> {
  dotenv.config({ quiet: true });
  const store = configStoreExists() ? loadConfigStore() : null;

  if (store) {
    console.error("[config] Loaded base config from ~/.brightspace-mcp/config.json");
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

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export type { AppConfig };
