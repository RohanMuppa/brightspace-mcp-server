/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeFileAtomicSync } from "./atomic-write.js";

/** JSON schema for ~/.brightspace-mcp/config.json */
export interface ConfigStoreData {
  baseUrl?: string;
  username?: string;
  /** Read only for migration from v1. Never written by saveConfigStore. */
  password?: string;
  campus?: string;
  sessionDir?: string;
  tokenTtl?: number;
  headless?: boolean;
  /**
   * Tick Microsoft's "Don't ask again" box so later sign-ins can skip the
   * second factor. Asked by setup, off by default; D2L_REMEMBER_MFA overrides.
   */
  rememberMfa?: boolean;
  includeCourses?: number[];
  excludeCourses?: number[];
  activeOnly?: boolean;
  /**
   * Only include courses whose Access.StartDate ≤ now ≤ Access.EndDate,
   * matching Brightspace's "Current Courses" widget. Overridable via
   * D2L_CURRENT_ONLY.
   */
  currentOnly?: boolean;
}

const CONFIG_DIR = path.join(os.homedir(), ".brightspace-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function configStoreExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export function loadConfigStore(): ConfigStoreData {
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(raw) as ConfigStoreData;
}

export function saveConfigStore(config: ConfigStoreData): void {
  if (config.password !== undefined) {
    throw new Error("Passwords must be saved in the native credential store before saving configuration.");
  }
  const isWindows = process.platform === "win32";
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, ...(isWindows ? {} : { mode: 0o700 }) });
  }
  writeFileAtomicSync(
    CONFIG_FILE,
    JSON.stringify(config, null, 2) + "\n",
    isWindows ? {} : { mode: 0o600 }
  );
}

export function getConfigStorePath(): string {
  return CONFIG_FILE;
}
