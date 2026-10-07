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
import { normalizeTotpEnrollment } from "./auth/totp.js";
import { writeFileAtomicSync } from "./utils/atomic-write.js";
import type { ConfigStoreData } from "./utils/config-store.js";
import { AUTH_COMMAND, DOCTOR_COMMAND } from "./utils/commands.js";
import {
  classifyRegistration,
  cliMcpClients,
  inspectCliMcpClient,
  isCliAvailable,
  registerCliMcpClient,
  serverCommand,
  type Registration,
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
  tudelft: {
    name: "TU Delft",
    baseUrl: "https://brightspace.tudelft.nl",
    usernameLabel: "TU Delft NetID",
    mfaNote: "NetID sign-in normally runs headlessly without MFA.",
    usernameHint: "Use your NetID, not your student email address.",
  },
  leiden: {
    name: "Leiden University",
    baseUrl: "https://brightspace.universiteitleiden.nl",
    usernameLabel: "Leiden University username",
    mfaNote: "Leiden usually asks for a code from your authenticator app, which you can type here.",
    usernameHint: "Use the full address you sign in to Microsoft with, e.g. s1234567@vuw.leidenuniv.nl.",
  },
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
  cuny: {
    name: "CUNY",
    baseUrl: "https://brightspace.cuny.edu",
    usernameLabel: "CUNY Login username",
    mfaNote: "Type the 6-digit code from your authenticator app when prompted.",
    usernameHint: "Use your full CUNY Login address, e.g. firstname.lastname01@login.cuny.edu",
  },
  ngeeann: {
    name: "Ngee Ann Polytechnic",
    baseUrl: "https://nplms.polite.edu.sg",
    usernameLabel: "Ngee Ann Polytechnic account username or full email",
    mfaNote: "Approve the sign-in request from your MFA app.",
    usernameHint: "Use your full sign-in address if your Ngee Ann Polytechnic account requires it.",
  },
  mcgill: {
    name: "McGill University",
    baseUrl: "https://mycourses2.mcgill.ca",
    usernameLabel: "McGill username or full email",
    mfaNote: "Approve the sign-in request from your MFA app.",
    usernameHint: "Use your full sign-in address if your McGill account requires it.",
  },
  javeriana: {
    name: "Pontificia Universidad Javeriana Cali",
    baseUrl: "https://auladigital.javerianacali.edu.co",
    usernameLabel: "Javeriana username",
    mfaNote: "OneGate asks for a code from your authenticator app when you sign in.",
  },
};

/**
 * Pick the school preset named by `--purdue`, `--suny`, `--western`, `--cuny`, `--mcgill`, `--ngeeann`, `--javeriana`, etc.
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

export interface PasswordInput {
  password: string;
  /** What to print back: one asterisk per accepted character, or erasures. */
  echo: string;
  outcome: "pending" | "submit" | "cancel";
}

/**
 * Apply one raw-mode stdin chunk to the password typed so far. A paste
 * arrives as a single chunk, possibly wrapped in bracketed-paste markers and
 * ending in a copied newline, so the chunk is read one character at a time
 * and escape sequences (paste markers, arrow keys) never reach the password.
 */
export function readPasswordInput(password: string, chunk: string): PasswordInput {
  let echo = "";
  const text = chunk.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  for (const ch of text) {
    if (ch === "\x03") return { password, echo, outcome: "cancel" };
    if (ch === "\r" || ch === "\n") return { password, echo, outcome: "submit" };
    if (ch === "\x7f" || ch === "\b") {
      if (password.length > 0) {
        password = [...password].slice(0, -1).join("");
        echo += "\b \b";
      }
      continue;
    }
    if (ch < " ") continue;
    password += ch;
    echo += "*";
  }
  return { password, echo, outcome: "pending" };
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
      const input = readPasswordInput(password, key.toString("utf-8"));
      if (input.echo) origWrite(input.echo);
      password = input.password;
      if (input.outcome === "pending") return;
      process.stdout.write = origWrite;
      process.stdin.setRawMode?.(false);
      process.stdin.removeListener("data", onData);
      rl.close();
      if (input.outcome === "cancel") {
        console.log("");
        process.exit(0);
      }
      origWrite("\n");
      resolve(password);
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

// ── Claude Desktop / Cursor / Antigravity config ────────────────────────────────

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

function getAntigravityConfigPath(): string {
  return path.join(os.homedir(), ".gemini", "antigravity", "mcp_config.json");
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

// ── Saved settings ─────────────────────────────────────────────────

export interface WizardAnswers {
  baseUrl: string;
  username: string;
  /** Absent when passwordless sign-in was chosen: nothing is saved. */
  password?: string;
  /** An authenticator enrollment to save; absent leaves any saved one alone. */
  totpUri?: string;
  headless: boolean;
  /** Left undefined, the saved choice for the same school is kept. */
  rememberMfa?: boolean;
  passwordless?: boolean;
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
    password: answers.passwordless ? undefined : answers.password,
    // Only ever the freshly typed one. Never read back out of `carried`: the
    // enrollment lives in the credential store, never in config.json, so a
    // value here could only have come from this run.
    ...(answers.totpUri ? { totpUri: answers.totpUri } : {}),
    headless: answers.headless,
  };
  if (answers.rememberMfa !== undefined) config.rememberMfa = answers.rememberMfa;
  if (answers.passwordless !== undefined) config.passwordless = answers.passwordless;
  if (answers.campus) config.campus = answers.campus;
  return config;
}

// ── Auth spawn ─────────────────────────────────────────────────────

/**
 * Registers Brightspace in one client, never silently replacing an entry
 * that points somewhere else: a matching entry is left alone, and a different
 * one is printed (so it can be restored) and replaced only on a yes.
 * Resolves true when the client ends up running the expected entry.
 */
async function registerWithClient(
  rl: readline.Interface,
  displayName: string,
  existing: Registration,
  write: (replace: boolean) => boolean,
): Promise<boolean> {
  if (existing.state === "current") {
    console.log(green(`  ${displayName} already has Brightspace configured.`));
    return true;
  }

  if (existing.state === "different") {
    console.log(yellow(`  ${displayName} has "brightspace" pointing at:`));
    console.log(`    ${existing.current}`);
    const replace = await ask(rl, `  Replace it with ${serverCommand().join(" ")}? (yes/no): `);
    if (!/^y(es)?$/i.test(replace)) {
      console.log(dim(`  Left ${displayName} unchanged.`));
      return false;
    }
  }

  try {
    if (write(existing.state === "different")) {
      console.log(green(`  ${displayName} configured!`));
      return true;
    }
    console.log(yellow(`  Could not configure ${displayName}. See README.md for the manual command.`));
  } catch (err) {
    console.log(
      yellow(`  Could not configure ${displayName}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
  return false;
}

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
    console.log(dim("  Your school's Brightspace address — the web address you open to see your courses."));
    while (!baseUrl) {
      const raw = await ask(
        rl,
        "What is your Brightspace address? (e.g., purdue.brightspace.com): ",
      );
      const normalized = normalizeUrl(raw);
      if (!raw || !isValidUrl(normalized)) {
        console.log(yellow("  Please enter a valid address, like purdue.brightspace.com"));
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
    : "What username do you use to sign in to Brightspace? ";
  if (preset?.usernameHint) {
    console.log(dim(`  ${preset.usernameHint}`));
  } else {
    console.log(dim("  The same username you type on your school's Brightspace sign-in page."));
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
  // Opt-in only, asked the way remember-MFA is: passwordless trades a saved
  // password for a phone approval on every sign-in, so it is never the default.
  let savedPasswordless: boolean | undefined;
  try {
    savedPasswordless = configStoreExists() ? loadConfigStore().passwordless : undefined;
  } catch {
    // An invalid old config is replaced by the setup values below.
  }
  console.log(dim("  Microsoft Entra schools can sign you in with only a phone approval, so no password is saved on this computer."));
  console.log(dim("  The cost: every sign-in, including automatic ones after a session expires, waits until you approve on your phone."));
  console.log(dim("  Fine for using an assistant at your desk; not for unattended or scheduled use. It needs passwordless phone sign-in"));
  console.log(dim("  turned on in Microsoft Authenticator first, or Microsoft will still ask for a password and sign-in will stop."));
  const defaultPasswordless = savedPasswordless === true ? "yes" : "no";
  let passwordlessAnswer = "";
  while (!/^(y(es)?|no?)$/i.test(passwordlessAnswer)) {
    passwordlessAnswer = await ask(
      rl,
      `  Sign in without a saved password (Microsoft Entra only)? (yes/no) [${defaultPasswordless}]: `,
    ) || defaultPasswordless;
    if (!/^(y(es)?|no?)$/i.test(passwordlessAnswer)) console.log(yellow("  Please enter yes or no."));
  }
  const passwordless = /^y/i.test(passwordlessAnswer);
  console.log("");

  // Close the rl temporarily since askPassword manages its own
  rl.close();

  let password = "";
  if (!passwordless) {
    console.log(dim("  The password you use to sign in. It won't be shown as you type — asterisks stand in for each character."));
    const passwordPrompt = preset
      ? `What is your ${preset.name} password? `
      : "What is your Brightspace password? ";
    while (!password) {
      password = await askPassword(passwordPrompt);
      if (!password) {
        console.log(yellow("  Password is required."));
      }
    }
    console.log("");
  }

  // ── Step 3b: Authenticator enrollment (hidden, optional) ─────────
  // Opt-in and off by default. Asked without naming a school: whether a code
  // can be typed depends on the identity provider and the challenge it shows,
  // which is only known at sign-in time.
  console.log(dim("  Optional. If your school asks for a 6-digit code from an authenticator app, this computer can generate it"));
  console.log(dim("  for you, so automatic sign-ins need nothing from your phone. Paste the SETUP KEY (or otpauth:// link) you"));
  console.log(dim("  got when enrolling the app — a code showing on screen right now will not work."));
  console.log(dim("  The tradeoff: the key is stored beside your password, so on THIS computer the two factors become one."));
  console.log(dim("  It still stops anyone who only has your password. Press Enter to skip, or to keep a key you saved before."));
  let totpUri: string | undefined;
  while (true) {
    const input = await askPassword("  Authenticator setup key or otpauth:// link (optional): ");
    if (!input) break;
    try {
      totpUri = normalizeTotpEnrollment(input, username);
      break;
    } catch {
      console.log(yellow("  That is not a setup key or otpauth:// link. Paste the enrollment key, or press Enter to skip."));
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
  console.log(dim("  Your school may ask you to approve the sign-in a second way — on your phone, with a code, or something else."));
  if (preset) {
    console.log(dim(`  ${preset.mfaNote}`));
  } else {
    console.log(dim("  You'll be prompted to approve the sign-in on your phone during auth."));
  }
  console.log("");
  // Only two outcomes exist: a hidden browser or a visible one. Which kind of
  // MFA you have is detected at sign-in time, so offering "approve a prompt"
  // and "type a code" as separate choices would be a distinction the code does
  // not make, and picking between them would change nothing on disk.
  console.log("  When your school asks you to approve the sign-in, how will you do it?");
  console.log("    1. I approve on my phone, or I type a code from an authenticator app (recommended)");
  console.log("    2. Something else — open a browser window I can use");
  let savedHeadless: boolean | undefined;
  let savedRememberMfa: boolean | undefined;
  try {
    const saved = configStoreExists() ? loadConfigStore() : undefined;
    savedHeadless = saved?.headless;
    savedRememberMfa = saved?.rememberMfa;
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

  // Opt-in only: a shared computer must never skip MFA unless asked to.
  const defaultRemember = savedRememberMfa === true ? "yes" : "no";
  let rememberAnswer = "";
  while (!/^(y(es)?|no?)$/i.test(rememberAnswer)) {
    rememberAnswer = await ask(
      rl2,
      `  Remember this device so later sign-ins can skip the second factor? Not for shared computers. (yes/no) [${defaultRemember}]: `,
    ) || defaultRemember;
    if (!/^(y(es)?|no?)$/i.test(rememberAnswer)) console.log(yellow("  Please enter yes or no."));
  }
  const rememberMfa = /^y/i.test(rememberAnswer);
  console.log(dim(rememberMfa
    ? "  Later sign-ins will ask Microsoft not to repeat the second factor on this device."
    : "  Every sign-in will ask for the second factor."));
  console.log("");

  // ── Step 5: Save config ──────────────────────────────────────────
  const config = buildConfigToSave(readExistingConfig(), {
    baseUrl,
    username,
    password,
    totpUri,
    headless,
    rememberMfa,
    passwordless,
    campus: campus || undefined,
  });

  await saveSecureConfig(config);
  console.log(green(passwordless
    ? "  No password saved: each sign-in will wait for your phone approval."
    : "  Password saved in your operating system credential store."));
  if (totpUri) console.log(green("  Authenticator enrollment saved in your operating system credential store."));
  console.log(green("  Config saved to: " + getConfigStorePath()));
  console.log("");

  // ── Step 6: Authenticate now? ────────────────────────────────────
  const authNow = await ask(rl2, "Sign in now, so everything is ready to go? (yes/no): ");
  if (/^y(es)?$/i.test(authNow)) {
    rl2.close();
    console.log("");
    console.log(dim("  Signing you in..."));
    console.log("");
    const ok = await runAuth();
    rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (ok) {
      console.log(green("\n  Signed in!"));
    } else {
      console.log(yellow(`\n  Sign-in didn't finish. You can try again later by running: ${AUTH_COMMAND}`));
    }
  } else {
    console.log(dim(`  You can sign in later by running: ${AUTH_COMMAND}`));
  }
  console.log("");

  // ── Step 7: Claude Desktop auto-config ───────────────────────────
  const claudePath = getClaudeDesktopConfigPath();
  if (claudePath) {
    const configClaude = await ask(
      rl2,
      "Would you like to automatically configure Claude Desktop? (yes/no): ",
    );
    if (
      /^y(es)?$/i.test(configClaude) &&
      await registerWithClient(rl2, "Claude Desktop", inspectMcpClient(claudePath), () =>
        configureMcpClient(claudePath))
    ) {
      configuredClients.push("Claude Desktop");
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
    if (
      /^y(es)?$/i.test(configCursor) &&
      await registerWithClient(rl2, "Cursor", inspectMcpClient(cursorPath), () =>
        configureMcpClient(cursorPath))
    ) {
      configuredClients.push("Cursor");
    }
    console.log("");
  }

  // ── Antigravity auto-config ──────────────────────────────────────
  const antigravityPath = getAntigravityConfigPath();
  if (fs.existsSync(path.dirname(antigravityPath))) {
    const configAntigravity = await ask(
      rl2,
      "Antigravity detected. Would you like to configure it too? (yes/no): ",
    );
    if (
      /^y(es)?$/i.test(configAntigravity) &&
      await registerWithClient(rl2, "Antigravity", inspectMcpClient(antigravityPath), () =>
        configureMcpClient(antigravityPath))
    ) {
      configuredClients.push("Antigravity");
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
    if (
      /^y(es)?$/i.test(configureClient) &&
      await registerWithClient(rl2, client.displayName, inspectCliMcpClient(client), (replace) =>
        registerCliMcpClient(client, { replace }))
    ) {
      configuredClients.push(client.displayName);
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
    console.log(`  2. Ask it: "What's due this week?"`);
    console.log("     Sign-in runs automatically if your saved session has expired.");
  } else {
    console.log("  1. Register the MCP server in your AI client using the command in README.md");
    console.log(`  2. Restart your AI client, then ask it: "What's due this week?"`);
  }
  console.log("");
  console.log(dim(`  If something doesn't work, run: ${DOCTOR_COMMAND}`));
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
