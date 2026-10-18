/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * The AI apps setup can register the server in. The interactive wizard asks
 * about each one; `setup --prepare` registers every one it finds without
 * asking. Both walk the same list from detectMcpClients.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomicSync } from "../utils/atomic-write.js";
import {
  classifyRegistration,
  cliMcpClients,
  inspectCliMcpClient,
  isCliAvailable,
  registerCliMcpClient,
  serverCommand,
  type CommandRunner,
  type Registration,
} from "../utils/mcp-client-cli.js";

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function getClaudeDesktopConfigPath(
  platform: NodeJS.Platform = os.platform(),
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appdata = env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appdata, "Claude", "claude_desktop_config.json");
  }
  if (platform === "linux") {
    return path.join(home, ".config", "Claude", "claude_desktop_config.json");
  }
  return null;
}

export function isChatGPTInstalled(): boolean {
  const platform = os.platform();
  if (platform === "darwin") {
    return (
      fs.existsSync("/Applications/ChatGPT.app") ||
      fs.existsSync(path.join(os.homedir(), "Applications", "ChatGPT.app"))
    );
  }
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return fs.existsSync(path.join(localAppData, "Programs", "ChatGPT", "ChatGPT.exe"));
  }
  return false;
}

export function getCursorConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".cursor", "mcp.json");
}

export function getAntigravityConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity", "mcp_config.json");
}

/**
 * A JSON value we can safely merge a server entry into. An array passes
 * `typeof x === "object"` but drops every added key when it is stringified
 * again, so it has to be rejected alongside `null`.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How the client's existing "brightspace" entry compares with ours. */
export function inspectMcpClient(configPath: string): Registration {
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    // No file, or one configureMcpClient would replace anyway.
    return { state: "missing" };
  }
  const servers = isJsonObject(config) ? config.mcpServers : undefined;
  return classifyRegistration(isJsonObject(servers) ? servers.brightspace : undefined);
}

export function configureMcpClient(configPath: string, warn: (line: string) => void = console.log): boolean {
  let config: McpConfig = {};

  // Read existing config if present
  if (fs.existsSync(configPath)) {
    let parsed: unknown;
    let readable = true;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      readable = false;
    }
    if (isJsonObject(parsed)) {
      config = parsed as McpConfig;
    } else {
      // Unparseable, or valid JSON that is not an object (null, an array, a
      // bare string). Merging into it would either throw or silently discard
      // the entry we just reported as written, so start fresh and say so.
      warn(yellow(`  Warning: existing config was ${readable ? "not a JSON object" : "invalid"}, creating new one.`));
      config = {};
    }
  }

  // Same reasoning for the servers map itself, which is hand-edited far more
  // often than the file around it.
  const servers: Record<string, unknown> = isJsonObject(config.mcpServers) ? config.mcpServers : {};
  config.mcpServers = servers;

  // Add/update brightspace entry
  const [command, ...args] = serverCommand();
  servers["brightspace"] = { command, args };

  // Ensure parent directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // This file holds every MCP server the user has configured, not just ours.
  // A plain write truncates it first, so a write that fails part way through
  // (a full disk, an I/O error) would leave the user with no MCP servers at
  // all. Staging and renaming leaves either the old file or the new one.
  // The existing permissions are carried over, since the rename would
  // otherwise replace them with the umask default.
  let mode: number | undefined;
  try {
    if (fs.existsSync(configPath)) mode = fs.statSync(configPath).mode & 0o777;
  } catch {
    // Unreadable metadata is not a reason to skip the write.
  }
  writeFileAtomicSync(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
    mode === undefined ? {} : { mode },
  );
  return true;
}

// ── One list of apps for the wizard and for prepare ────────────────

export interface McpClientTarget {
  id: "claude-desktop" | "cursor" | "antigravity" | "codex" | "claude-code";
  name: string;
  /**
   * True when the app looks installed. Only Claude Desktop is listed without
   * being installed: the wizard has always offered it, so someone can set it
   * up before installing the app. Prepare registers detected apps only.
   */
  detected: boolean;
  /** The wizard's yes/no question for this app. */
  question: string;
  inspect(): Registration;
  write(replace: boolean): boolean;
}

export interface ClientDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  existsSync: (p: string) => boolean;
  runCommand?: CommandRunner;
  /** Where configureMcpClient reports a config file it had to start over. */
  warn: (line: string) => void;
}

export function detectMcpClients(overrides: Partial<ClientDeps> = {}): McpClientTarget[] {
  const deps: ClientDeps = {
    platform: os.platform(),
    home: os.homedir(),
    env: process.env,
    existsSync: fs.existsSync,
    warn: console.log,
    ...overrides,
  };
  const targets: McpClientTarget[] = [];
  const fileTarget = (
    id: McpClientTarget["id"],
    name: string,
    configPath: string,
    question: string,
  ): McpClientTarget => ({
    id,
    name,
    detected: deps.existsSync(path.dirname(configPath)),
    question,
    inspect: () => inspectMcpClient(configPath),
    write: () => configureMcpClient(configPath, deps.warn),
  });

  const claudePath = getClaudeDesktopConfigPath(deps.platform, deps.home, deps.env);
  if (claudePath) {
    targets.push(fileTarget("claude-desktop", "Claude Desktop", claudePath,
      "Would you like to automatically configure Claude Desktop? Highly recommended. (yes/no): "));
  }
  const cursorPath = getCursorConfigPath(deps.home);
  if (deps.existsSync(path.dirname(cursorPath))) {
    targets.push(fileTarget("cursor", "Cursor", cursorPath,
      "Cursor detected. Would you like to configure it too? (yes/no): "));
  }
  const antigravityPath = getAntigravityConfigPath(deps.home);
  if (deps.existsSync(path.dirname(antigravityPath))) {
    targets.push(fileTarget("antigravity", "Antigravity", antigravityPath,
      "Antigravity detected. Would you like to configure it too? (yes/no): "));
  }

  for (const client of cliMcpClients(deps.platform)) {
    if (!isCliAvailable(client, deps.runCommand)) continue;
    targets.push({
      id: client.id,
      name: client.displayName,
      detected: true,
      question: `${client.displayName} detected. Configure it automatically? Highly recommended. (yes/no): `,
      inspect: () => inspectCliMcpClient(client, deps.runCommand),
      write: (replace) => registerCliMcpClient(client, { replace }, deps.runCommand),
    });
  }
  return targets;
}

export type RegistrationOutcome =
  | { id: McpClientTarget["id"]; name: string; outcome: "added" | "current" | "replaced" }
  | { id: McpClientTarget["id"]; name: string; outcome: "different_left"; current: string }
  | { id: McpClientTarget["id"]; name: string; outcome: "failed"; message: string };

/**
 * Register the server in every given app without asking. An entry that runs
 * something else is left alone unless `replace` is set, and a write that
 * fails (an agent's sandbox may block another app's settings folder) is
 * reported for that app instead of stopping the rest.
 */
export function registerAll(targets: McpClientTarget[], { replace }: { replace: boolean }): RegistrationOutcome[] {
  return targets.map((target): RegistrationOutcome => {
    const base = { id: target.id, name: target.name };
    try {
      const existing = target.inspect();
      if (existing.state === "current") return { ...base, outcome: "current" };
      if (existing.state === "different" && !replace) {
        return { ...base, outcome: "different_left", current: existing.current };
      }
      if (!target.write(existing.state === "different")) {
        return { ...base, outcome: "failed", message: `${target.name} did not accept the registration.` };
      }
      return { ...base, outcome: existing.state === "different" ? "replaced" : "added" };
    } catch (error) {
      return { ...base, outcome: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  });
}
