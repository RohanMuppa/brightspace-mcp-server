#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  configStoreExists,
  getConfigStorePath,
  loadConfigStore,
} from "./utils/config-store.js";
import { saveSecureConfig } from "./utils/secure-config.js";
import { writeFileAtomicSync } from "./utils/atomic-write.js";
import type { ConfigStoreData } from "./utils/config-store.js";
import { AUTH_COMMAND } from "./utils/commands.js";
import {
  cliMcpClients,
  configureCliMcpClient,
  isCliAvailable,
} from "./utils/mcp-client-cli.js";

// ANSI helpers
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const thisDir = path.dirname(fileURLToPath(import.meta.url));

// ── School presets ──────────────────────────────────────────────────

interface SchoolPreset {
  name: string;
  baseUrl: string;
  usernameLabel: string;
  mfaNote: string;
  /** Asked only by shared instances that host several campuses. */
  campusPrompt?: string;
  /** Shown above the username prompt when the expected format is not obvious. */
  usernameHint?: string;
}

export const SCHOOL_PRESETS: Record<string, SchoolPreset> = {
  purdue: {
    name: "Purdue University",
    baseUrl: "https://purdue.brightspace.com",
    usernameLabel: "Purdue career account username or full email",
    mfaNote: "Microsoft Authenticator number matching can run without a browser window.",
  },
  suny: {
    name: "SUNY",
    baseUrl: "https://mylearning.suny.edu",
    usernameLabel: "SUNY campus username",
    mfaNote: "Approve the sign-in request from your campus MFA app.",
    campusPrompt: "Which SUNY campus are you at? (e.g. SUNY Poly)",
    usernameHint: "Most campuses want the full sign-in address, e.g. abc123@sunypoly.edu",
  },
  western: {
    name: "Western University",
    baseUrl: "https://westernu.brightspace.com",
    usernameLabel: "Western account username or full email",
    mfaNote: "Approve the sign-in request from your MFA app.",
    usernameHint: "Use your full sign-in address if your Western account requires it.",
  },
};

/**
 * Pick the school preset named by `--purdue`, `--suny`, `--western`, etc.
 *
 * Own properties only: a bare index would make `--constructor` or
 * `--__proto__` resolve to something off `Object.prototype` and hand the
 * wizard an object with no `baseUrl`.
 */
export function presetForArgv(argv: string[] = process.argv): SchoolPreset | undefined {
  const flag = argv.find((a) => a.startsWith("--"))?.replace(/^--/, "").toLowerCase();
  if (!flag || !Object.prototype.hasOwnProperty.call(SCHOOL_PRESETS, flag)) return undefined;
  return SCHOOL_PRESETS[flag];
}

const preset = presetForArgv();

// ── Readline helpers ───────────────────────────────────────────────

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Prompt for a password without echoing characters to the terminal.
 * We swap stdout.write to suppress the default echo, then print
 * asterisks ourselves for each typed character.
 */
function askPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Mute the built-in echo
    const origWrite = process.stdout.write.bind(process.stdout);
    let password = "";
    let muted = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (
      chunk: any,
      encodingOrCb?: any,
      cb?: any,
    ): boolean => {
      if (muted) {
        // Swallow readline's echo completely
        if (typeof encodingOrCb === "function") {
          encodingOrCb();
          return true;
        }
        if (cb) cb();
        return true;
      }
      return origWrite(chunk, encodingOrCb, cb);
    };

    origWrite(prompt);
    muted = true;

    process.stdin.setRawMode?.(true);
    process.stdin.resume();

    const onData = (key: Buffer) => {
      const ch = key.toString("utf-8");
      // Ctrl+C
      if (ch === "\x03") {
        process.stdout.write = origWrite;
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener("data", onData);
        rl.close();
        console.log("");
        process.exit(0);
      }
      // Enter
      if (ch === "\r" || ch === "\n") {
        process.stdout.write = origWrite;
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener("data", onData);
        rl.close();
        origWrite("\n");
        resolve(password);
        return;
      }
      // Backspace
      if (ch === "\x7f" || ch === "\b") {
        if (password.length > 0) {
          password = password.slice(0, -1);
          origWrite("\b \b");
        }
        return;
      }
      // Normal character
      password += ch;
      origWrite("*");
    };

    process.stdin.on("data", onData);
  });
}

// ── URL validation ─────────────────────────────────────────────────

function normalizeUrl(input: string): string {
  let url = input.trim();
  // Strip trailing slashes
  url = url.replace(/\/+$/, "");
  // Auto-prepend https://
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // Upgrade http:// to https://
  url = url.replace(/^http:\/\//i, "https://");
  return url;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

// ── Claude Desktop / Cursor config ────────────────────────────────

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function getClaudeDesktopConfigPath(): string | null {
  const platform = os.platform();
  if (platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }
  if (platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "Claude", "claude_desktop_config.json");
  }
  if (platform === "linux") {
    return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
  return null;
}

function isChatGPTInstalled(): boolean {
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

function getCursorConfigPath(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

/**
 * A JSON value we can safely merge a server entry into. An array passes
 * `typeof x === "object"` but drops every added key when it is stringified
 * again, so it has to be rejected alongside `null`.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configureMcpClient(configPath: string): boolean {
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
      console.log(yellow(`  Warning: existing config was ${readable ? "not a JSON object" : "invalid"}, creating new one.`));
      config = {};
    }
  }

  // Same reasoning for the servers map itself, which is hand-edited far more
  // often than the file around it.
  const servers: Record<string, unknown> = isJsonObject(config.mcpServers) ? config.mcpServers : {};
  config.mcpServers = servers;

  // Add/update brightspace entry
  // On Windows, npx is a .cmd shim that must be invoked through cmd.exe
  const isWindows = process.platform === "win32";
  servers["brightspace"] = isWindows
    ? {
        command: "cmd",
        args: ["/c", "npx", "-y", "brightspace-mcp-server@latest"],
      }
    : {
        command: "npx",
        args: ["-y", "brightspace-mcp-server@latest"],
      };

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

// ── Saved settings ─────────────────────────────────────────────────

export interface WizardAnswers {
  baseUrl: string;
  username: string;
  password: string;
  headless: boolean;
  campus?: string;
}

/** The settings already on disk, or null when there are none to read. */
export function readExistingConfig(): ConfigStoreData | null {
  try {
    return configStoreExists() ? loadConfigStore() : null;
  } catch {
    // An unreadable config is replaced by the setup values.
    return null;
  }
}

function sameSchool(stored: string | undefined, chosen: string): boolean {
  // A config that never recorded a school (environment-driven installs) is
  // not a *different* school, so its settings are still ours to keep.
  if (!stored) return true;
  try {
    return new URL(stored).origin === new URL(chosen).origin;
  } catch {
    return false;
  }
}

/**
 * Merge the wizard's answers over the settings already saved.
 *
 * `saveConfigStore` replaces the whole file, and setup is the documented way
 * to update a saved password — so it runs again on configurations that carry
 * settings it never prompts for: the SUNY campus, course filters, a custom
 * session directory or token TTL. Writing only the answers deleted all of
 * them; most visibly, a SUNY user who reran plain `setup` lost the campus
 * that lets sign-in skip the shared campus picker.
 *
 * Settings are carried only within one school, since course ids and the
 * campus belong to a single tenant.
 */
export function buildConfigToSave(
  existing: ConfigStoreData | null,
  answers: WizardAnswers,
): ConfigStoreData {
  const carried = existing && sameSchool(existing.baseUrl, answers.baseUrl) ? existing : null;
  const config: ConfigStoreData = {
    ...carried,
    baseUrl: answers.baseUrl,
    username: answers.username,
    // Always the freshly typed one: a carried v1 plaintext password would
    // otherwise be the value written to the native store.
    password: answers.password,
    headless: answers.headless,
  };
  if (answers.campus) config.campus = answers.campus;
  return config;
}

// ── Auth spawn ─────────────────────────────────────────────────────

function runAuth(): Promise<boolean> {
  const scriptPath = path.resolve(thisDir, "auth-cli.js");

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [scriptPath],
      {
        env: { ...process.env },
        stdio: "inherit",
      },
    );
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

// ── Main wizard ────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    console.log("\n\nSetup cancelled.");
    process.exit(0);
  });

  console.log("");
  if (preset) {
    console.log(bold(`Brightspace MCP Server — ${preset.name} Setup`));
    console.log("=".repeat(`Brightspace MCP Server — ${preset.name} Setup`.length));
  } else {
    console.log(bold("Brightspace MCP Server — Setup Wizard"));
    console.log("======================================");
  }
  console.log(dim("  By Rohan Muppa — github.com/rohanmuppa/brightspace-mcp-server"));
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // ── Step 1: Brightspace URL ──────────────────────────────────────
  let baseUrl = "";
  if (preset) {
    baseUrl = preset.baseUrl;
    console.log(dim(`  Brightspace URL: ${baseUrl}`));
    console.log("");
  } else {
    while (!baseUrl) {
      const raw = await ask(
        rl,
        "What is your Brightspace URL? (e.g., purdue.brightspace.com): ",
      );
      const normalized = normalizeUrl(raw);
      if (!raw || !isValidUrl(normalized)) {
        console.log(yellow("  Please enter a valid URL (e.g., purdue.brightspace.com)"));
        continue;
      }
      baseUrl = normalized;
    }
    console.log(dim(`  → ${baseUrl}`));
    console.log("");
  }

  // ── Campus (shared multi-campus instances only) ──────────────────
  let campus = "";
  if (preset?.campusPrompt) {
    console.log(dim("  Several campuses share this Brightspace site."));
    while (!campus) {
      campus = await ask(rl, `${preset.campusPrompt} `);
      if (!campus) console.log(yellow("  Campus is required for automatic sign-in."));
    }
    console.log(
      campus
        ? dim(`  → ${campus}`)
        : dim("  Set your campus before authenticating."),
    );
    console.log("");
  }

  // ── Step 2: Username ─────────────────────────────────────────────
  const usernamePrompt = preset
    ? `What is your ${preset.usernameLabel}? `
    : "What is your Brightspace username? ";
  if (preset?.usernameHint) {
    console.log(dim(`  ${preset.usernameHint}`));
  }
  let username = "";
  while (!username) {
    username = await ask(rl, usernamePrompt);
    if (!username) {
      console.log(yellow("  Username is required."));
    }
  }
  console.log("");

  // ── Step 3: Password (hidden) ────────────────────────────────────
  // Close the rl temporarily since askPassword manages its own
  rl.close();

  const passwordPrompt = preset
    ? `What is your ${preset.usernameLabel.replace("username", "password")}? `
    : "What is your Brightspace password? ";
  let password = "";
  while (!password) {
    password = await askPassword(passwordPrompt);
    if (!password) {
      console.log(yellow("  Password is required."));
    }
  }
  console.log("");

  // Re-open readline for remaining prompts
  let rl2 = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const configuredClients: string[] = [];

  // ── Step 4: MFA info ─────────────────────────────────────────────
  if (preset) {
    console.log(dim(`  MFA: ${preset.mfaNote}`));
  } else {
    console.log(dim("  MFA: You will be prompted to approve the sign-in on your phone during auth."));
  }
  console.log("");
  // Only two outcomes exist: a hidden browser or a visible one. Which kind of
  // MFA you have is detected at sign-in time, so offering "approve a prompt"
  // and "type a code" as separate choices would be a distinction the code does
  // not make, and picking between them would change nothing on disk.
  console.log("  How do you complete MFA?");
  console.log("    1. On your phone, or by typing a code here (recommended)");
  console.log("    2. In a visible browser window");
  let savedHeadless: boolean | undefined;
  try {
    savedHeadless = configStoreExists() ? loadConfigStore().headless : undefined;
  } catch {
    // An invalid old config is replaced by the setup values below.
  }
  const defaultMfaChoice = savedHeadless === false ? "2" : "1";
  let mfaChoice = "";
  while (!/^[12]$/.test(mfaChoice)) {
    mfaChoice = await ask(rl2, `  Choose 1 or 2 [${defaultMfaChoice}]: `) || defaultMfaChoice;
    if (!/^[12]$/.test(mfaChoice)) console.log(yellow("  Please enter 1 or 2."));
  }
  const headless = mfaChoice !== "2";
  console.log(dim(headless
    ? "  Authentication will run without a browser window."
    : "  A browser window will open when authentication is needed."));
  console.log("");

  // ── Step 5: Save config ──────────────────────────────────────────
  const config = buildConfigToSave(readExistingConfig(), {
    baseUrl,
    username,
    password,
    headless,
    campus: campus || undefined,
  });

  await saveSecureConfig(config);
  console.log(green("  Password saved in your operating system credential store."));
  console.log(green("  Config saved to: " + getConfigStorePath()));
  console.log("");

  // ── Step 6: Authenticate now? ────────────────────────────────────
  const authNow = await ask(rl2, "Would you like to authenticate now? (yes/no): ");
  if (/^y(es)?$/i.test(authNow)) {
    rl2.close();
    console.log("");
    console.log(dim("  Starting authentication..."));
    console.log("");
    const ok = await runAuth();
    rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (ok) {
      console.log(green("\n  Authentication successful!"));
    } else {
      console.log(yellow(`\n  Authentication failed. You can retry later with: ${AUTH_COMMAND}`));
    }
  } else {
    console.log(dim(`  You can authenticate later by running: ${AUTH_COMMAND}`));
  }
  console.log("");

  // ── Step 7: Claude Desktop auto-config ───────────────────────────
  const claudePath = getClaudeDesktopConfigPath();
  if (claudePath) {
    const configClaude = await ask(
      rl2,
      "Would you like to automatically configure Claude Desktop? (yes/no): ",
    );
    if (/^y(es)?$/i.test(configClaude)) {
      try {
        configureMcpClient(claudePath);
        configuredClients.push("Claude Desktop");
        console.log(green("  Claude Desktop configured! Restart Claude Desktop to connect."));
      } catch (err) {
        console.log(
          yellow(`  Could not configure Claude Desktop: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
    console.log("");
  }

  // ── Step 8: Cursor auto-config ───────────────────────────────────
  const cursorPath = getCursorConfigPath();
  const cursorExists = fs.existsSync(path.dirname(cursorPath));
  if (cursorExists) {
    const configCursor = await ask(
      rl2,
      "Cursor detected. Would you like to configure it too? (yes/no): ",
    );
    if (/^y(es)?$/i.test(configCursor)) {
      try {
        configureMcpClient(cursorPath);
        configuredClients.push("Cursor");
        console.log(green("  Cursor configured! Restart Cursor to connect."));
      } catch (err) {
        console.log(
          yellow(`  Could not configure Cursor: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
    console.log("");
  }

  // ── Step 9: Codex and Claude Code auto-config ─────────────────────
  for (const client of cliMcpClients()) {
    if (!isCliAvailable(client)) continue;

    const configureClient = await ask(
      rl2,
      `${client.displayName} detected. Configure it automatically? (yes/no): `,
    );
    if (/^y(es)?$/i.test(configureClient)) {
      const result = configureCliMcpClient(client);
      if (result === "failed") {
        console.log(yellow(`  Could not configure ${client.displayName}. See README.md for the manual command.`));
      } else {
        configuredClients.push(client.displayName);
        const message = result === "already-configured"
          ? `  ${client.displayName} already has Brightspace configured.`
          : `  ${client.displayName} configured!`;
        console.log(green(message));
      }
    }
    console.log("");
  }

  // ── Step 10: ChatGPT Desktop instructions ────────────────────────
  if (isChatGPTInstalled()) {
    const isWindows = process.platform === "win32";
    const mcpJson = isWindows
      ? `{\n  "command": "cmd",\n  "args": ["/c", "npx", "-y", "brightspace-mcp-server@latest"]\n}`
      : `{\n  "command": "npx",\n  "args": ["-y", "brightspace-mcp-server@latest"]\n}`;
    console.log(yellow("  ChatGPT Desktop detected."));
    console.log(dim("  ChatGPT doesn't support automatic MCP config — add it manually:"));
    console.log(dim("  1. Open ChatGPT Desktop → Settings → Tools → Add MCP tool → Add manually"));
    console.log(dim("  2. Paste this config:"));
    console.log("");
    console.log(mcpJson);
    console.log("");
  }

  rl2.close();

  // ── Final summary ────────────────────────────────────────────────
  console.log(bold("Setup complete!"));
  console.log("");
  console.log(`  Config saved to: ${dim(getConfigStorePath())}`);
  console.log("");
  console.log("  Next steps:");
  if (configuredClients.length > 0) {
    console.log(`  1. Restart ${configuredClients.join(", ")}`);
    console.log("  2. Ask your AI client about your Brightspace courses");
    console.log("     Sign-in runs automatically if your saved session has expired.");
  } else {
    console.log("  1. Register the MCP server in your AI client using the command in README.md");
    console.log("  2. Restart your AI client and ask about your Brightspace courses");
  }
  console.log("");
}

// Both entry points — the `brightspace-setup` bin and `brightspace-mcp-server
// setup`, which imports this module — start the wizard here. VITEST is set
// only by the test runner, which imports the module for the helpers above and
// must not open prompts on stdin; no user environment sets it.
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error("Setup failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
