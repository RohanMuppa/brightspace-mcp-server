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
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveConfigStore, getConfigStorePath } from "./utils/config-store.js";
import type { ConfigStoreData } from "./utils/config-store.js";

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

const SCHOOL_PRESETS: Record<string, SchoolPreset> = {
  purdue: {
    name: "Purdue University",
    baseUrl: "https://purdue.brightspace.com",
    usernameLabel: "Purdue career account username",
    mfaNote: "Approve the Duo push on your phone.",
  },
  suny: {
    name: "SUNY",
    baseUrl: "https://mylearning.suny.edu",
    usernameLabel: "SUNY campus username",
    mfaNote: "Approve the sign-in request from your campus MFA app.",
    campusPrompt: "Which SUNY campus are you at? (e.g. SUNY Poly)",
    usernameHint: "Most campuses want the full sign-in address, e.g. abc123@sunypoly.edu",
  },
};

// Parse --purdue, --osu, etc. from argv
const schoolFlag = process.argv.find((a) => a.startsWith("--"))?.replace(/^--/, "").toLowerCase();
const preset = schoolFlag ? SCHOOL_PRESETS[schoolFlag] : undefined;

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
    return parsed.protocol === "https:";
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

function configureMcpClient(configPath: string): boolean {
  let config: McpConfig = { mcpServers: {} };

  // Read existing config if present
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      config = JSON.parse(raw) as McpConfig;
    } catch {
      // If we can't parse, start fresh but warn
      console.log(yellow("  Warning: existing config was invalid, creating new one."));
      config = { mcpServers: {} };
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Add/update brightspace entry
  // On Windows, npx is a .cmd shim that must be invoked through cmd.exe
  const isWindows = process.platform === "win32";
  config.mcpServers["brightspace"] = isWindows
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

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return true;
}

// ── Auth spawn ─────────────────────────────────────────────────────

function runAuth(): Promise<boolean> {
  const scriptPath = path.resolve(thisDir, "auth-cli.js");

  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [scriptPath],
      {
        timeout: 3 * 60 * 1000,
        env: { ...process.env },
      },
      (error) => {
        resolve(!error);
      },
    );
    // Pipe child output so the user sees the auth flow
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
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
    campus = await ask(rl, `${preset.campusPrompt} `);
    console.log(
      campus
        ? dim(`  → ${campus}`)
        : dim("  No campus set — you'll pick it in the browser at sign-in."),
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
  const rl2 = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // ── Step 4: MFA info ─────────────────────────────────────────────
  if (preset) {
    console.log(dim(`  MFA: ${preset.mfaNote}`));
  } else {
    console.log(dim("  MFA: You will be prompted to approve the sign-in on your phone during auth."));
  }
  console.log("");

  // ── Step 5: Save config ──────────────────────────────────────────
  const config: ConfigStoreData = {
    baseUrl,
    username,
    password,
  };
  if (campus) {
    config.campus = campus;
  }

  saveConfigStore(config);
  console.log(green("  Config saved to: " + getConfigStorePath()));
  console.log("");

  // ── Step 6: Authenticate now? ────────────────────────────────────
  const authNow = await ask(rl2, "Would you like to authenticate now? (yes/no): ");
  if (/^y(es)?$/i.test(authNow)) {
    console.log("");
    console.log(dim("  Starting authentication..."));
    console.log("");
    const ok = await runAuth();
    if (ok) {
      console.log(green("\n  Authentication successful!"));
    } else {
      console.log(yellow("\n  Authentication failed. You can retry later with: brightspace-auth"));
    }
  } else {
    console.log(dim("  You can authenticate later by running: brightspace-auth"));
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
        console.log(green("  Cursor configured! Restart Cursor to connect."));
      } catch (err) {
        console.log(
          yellow(`  Could not configure Cursor: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
    console.log("");
  }

  // ── Step 9: ChatGPT Desktop instructions ─────────────────────────
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
  console.log("  1. Run 'brightspace-auth' to authenticate (if you haven't already)");
  console.log("  2. Restart Claude Desktop");
  console.log("  3. Ask Claude about your Brightspace courses!");
  console.log("");
}

main().catch((err) => {
  console.error("Setup failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
