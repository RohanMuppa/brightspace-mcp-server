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
  const headless = process.env.D2L_HEADLESS !== undefined
    ? process.env.D2L_HEADLESS !== "false"
    : store?.headless ?? true;

  // Resolve tokenTtl: env > store > default (3600)
  const tokenTtl = process.env.D2L_TOKEN_TTL
    ? parseInt(process.env.D2L_TOKEN_TTL, 10)
    : store?.tokenTtl ?? 3600;

  // Resolve includeCourseIds: env > store > undefined
  const includeCourseIds = process.env.D2L_INCLUDE_COURSES
    ? process.env.D2L_INCLUDE_COURSES.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : store?.includeCourses;

  // Resolve excludeCourseIds: env > store > undefined
  const excludeCourseIds = process.env.D2L_EXCLUDE_COURSES
    ? process.env.D2L_EXCLUDE_COURSES.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : store?.excludeCourses;

  // Resolve activeOnly: env > store > default (true)
  let activeOnly = store?.activeOnly ?? true;
  if (process.env.D2L_ACTIVE_ONLY !== undefined) {
    activeOnly = process.env.D2L_ACTIVE_ONLY !== 'false';
  }

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

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export type { AppConfig };
