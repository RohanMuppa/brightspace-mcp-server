#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 *
 * `setup`, in three modes (see src/setup/args.ts): the interactive wizard,
 * `--prepare` for an AI agent (src/setup/prepare.ts, no prompts), and
 * `--sign-in`, the person's last step after prepare.
 */

import * as readline from "node:readline";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getConfigStorePath } from "./utils/config-store.js";
import { saveSecureConfig } from "./utils/secure-config.js";
import { deleteStoredTotpUri, getStoredPassword, getStoredTotpUri } from "./auth/credential-store.js";
import { askShortcutQuestion, type ShortcutIO } from "./utils/two-factor-shortcuts.js";
import { DOCTOR_COMMAND, prepareCommand, signInCommand } from "./utils/commands.js";
import { serverCommand } from "./utils/mcp-client-cli.js";
import { parseSetupArgs, SETUP_USAGE, type SetupArgs } from "./setup/args.js";
import { buildConfigToSave, isValidUrl, normalizeUrl, readExistingConfig, sameSchool, savedUsername } from "./setup/config.js";
import { detectMcpClients, isChatGPTInstalled, type McpClientTarget } from "./setup/clients.js";
import { presetForBaseUrl, type SchoolPreset } from "./setup/presets.js";
import { formatPrepare, runPrepare } from "./setup/prepare.js";

// Kept importable from here for existing callers and tests.
export { SCHOOL_PRESETS } from "./setup/presets.js";
export { buildConfigToSave, readExistingConfig, type WizardAnswers } from "./setup/config.js";
export { configureMcpClient, inspectMcpClient } from "./setup/clients.js";

// ANSI helpers
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * The school preset named by a flag such as `--purdue`, anywhere on the
 * command line. Undefined when there is none or the flags don't parse.
 */
export function presetForArgv(argv: string[] = process.argv): SchoolPreset | undefined {
  const parsed = parseSetupArgs(argv);
  return parsed.ok ? parsed.args.preset : undefined;
}

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

// ── Which questions to ask ─────────────────────────────────────────

export interface QuestionPlan {
  askUrl: boolean;
  askCampus: boolean;
  askUsername: boolean;
  /** "keep-or-ask" offers to keep a password already saved for this account. */
  password: "ask" | "keep-or-ask";
  registerApps: boolean;
  /** The wizard asks "Sign in now?"; sign-in mode just signs in. */
  confirmSignIn: boolean;
}

export interface KnownAnswers {
  baseUrl?: string;
  campusNeeded: boolean;
  campus?: string;
  username?: string;
  passwordSaved: boolean;
}

/**
 * The wizard asks everything, as it always has. Sign-in mode runs after
 * `--prepare`, so it asks only what prepare couldn't know: the password (or
 * whether to keep a saved one), and the username or campus if the agent
 * didn't pass them. Registering apps was prepare's job.
 */
export function planQuestions(mode: "wizard" | "sign-in", known: KnownAnswers): QuestionPlan {
  const signIn = mode === "sign-in";
  return {
    askUrl: !known.baseUrl,
    askCampus: known.campusNeeded && !known.campus,
    askUsername: !known.username,
    password: signIn && known.passwordSaved ? "keep-or-ask" : "ask",
    registerApps: !signIn,
    confirmSignIn: !signIn,
  };
}

// ── Registering with one app ───────────────────────────────────────

/**
 * Registers Brightspace in one app, never silently replacing an entry
 * that points somewhere else: a matching entry is left alone, an entry using
 * the shared server by URL is kept unless the person asks to switch back, and
 * a different one is printed (so it can be restored) and replaced only on a yes.
 * Resolves true when the app ends up set up.
 */
export async function registerWithClient(
  target: McpClientTarget,
  askLine: (question: string) => Promise<string>,
  log: (line: string) => void = console.log,
): Promise<boolean> {
  const existing = target.inspect();
  if (existing.state === "current") {
    log(green(`  ${target.name} already has Brightspace configured.`));
    return true;
  }

  if (existing.state === "shared_http") {
    log(green(`  ${target.name} uses the shared Brightspace server at ${existing.url}.`));
    const switchBack = await askLine(`  Switch it back to its own copy per chat (${serverCommand().join(" ")})? (yes/no): `);
    if (!/^y(es)?$/i.test(switchBack)) {
      log(dim(`  Kept ${target.name} on the shared server.`));
      return true;
    }
  }

  if (existing.state === "different") {
    log(yellow(`  ${target.name} has "brightspace" pointing at:`));
    log(`    ${existing.current}`);
    const replace = await askLine(`  Replace it with ${serverCommand().join(" ")}? (yes/no): `);
    if (!/^y(es)?$/i.test(replace)) {
      log(dim(`  Left ${target.name} unchanged.`));
      return false;
    }
  }

  try {
    if (target.write(existing.state !== "missing")) {
      log(green(`  ${target.name} configured!`));
      return true;
    }
    log(yellow(`  Could not configure ${target.name}. See README.md for the manual command.`));
  } catch (err) {
    log(
      yellow(`  Could not configure ${target.name}: ${err instanceof Error ? err.message : String(err)}`),
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

function printChatGPTInstructions(): void {
  if (!isChatGPTInstalled()) return;
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

// ── Prepare (no prompts) ───────────────────────────────────────────

async function prepare(args: SetupArgs): Promise<void> {
  const result = await runPrepare(args);
  const lines = formatPrepare(result);
  if (args.json) {
    // stdout carries only the JSON an agent parses.
    for (const line of lines) console.error(line);
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const line of lines) console.log(line);
  }
  process.exitCode = result.state === "ready_for_sign_in" || result.state === "signed_in" ? 0 : 1;
}

// ── Wizard and sign-in (interactive) ───────────────────────────────

async function interactive(args: SetupArgs): Promise<void> {
  const mode = args.mode === "sign-in" ? "sign-in" : "wizard";

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    console.log("\n\nSetup cancelled.");
    process.exit(0);
  });

  const saved = readExistingConfig();

  // ── School ───────────────────────────────────────────────────────
  let baseUrl = args.preset?.baseUrl;
  if (!baseUrl && args.url) {
    const normalized = normalizeUrl(args.url);
    if (!isValidUrl(normalized)) {
      console.error(`"${args.url}" isn't a valid Brightspace address. Pass it like --url purdue.brightspace.com`);
      process.exitCode = 2;
      return;
    }
    baseUrl = new URL(normalized).origin;
  }
  if (!baseUrl && mode === "sign-in") {
    if (!saved?.baseUrl) {
      console.error(`No school is saved yet. Run ${prepareCommand()} with your school's flag first, or pass the flag here.`);
      process.exitCode = 2;
      return;
    }
    baseUrl = saved.baseUrl;
  }
  let preset = args.preset ?? (baseUrl ? presetForBaseUrl(baseUrl)?.preset : undefined);
  const carried = baseUrl && saved && sameSchool(saved.baseUrl, baseUrl) ? saved : null;

  const knownUsername = args.username !== undefined
    ? savedUsername(carried?.username, args.username)
    : mode === "sign-in" ? carried?.username : undefined;
  let passwordSaved = false;
  if (mode === "sign-in" && baseUrl && knownUsername) {
    try {
      passwordSaved = Boolean(await getStoredPassword(baseUrl, knownUsername));
    } catch {
      // A locked store: ask for the password, and saving it reports the problem.
    }
  }
  const plan = planQuestions(mode, {
    baseUrl,
    campusNeeded: Boolean(preset?.campusPrompt),
    campus: args.campus ?? (mode === "sign-in" ? carried?.campus : undefined),
    username: knownUsername,
    passwordSaved,
  });

  console.log("");
  const title = mode === "sign-in"
    ? `Brightspace MCP Server — ${preset ? `${preset.name} ` : ""}Sign-in`
    : preset ? `Brightspace MCP Server — ${preset.name} Setup` : "Brightspace MCP Server — Setup Wizard";
  console.log(bold(title));
  console.log("=".repeat(title.length));
  console.log(dim("  By Rohan Muppa — github.com/rohanmuppa/brightspace-mcp-server"));
  console.log("");
  // An assistant often opens this wizard in a side panel the user has never
  // used, and their typing keeps going to the chat box until they click here.
  console.log("  Click in this window, then type your answer to each question and press Enter.");
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // ── Step 1: Brightspace URL ──────────────────────────────────────
  if (!plan.askUrl && baseUrl) {
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
    preset ??= presetForBaseUrl(baseUrl)?.preset;
    console.log(dim(`  → ${baseUrl}`));
    console.log("");
  }

  // ── Campus (shared multi-campus instances only) ──────────────────
  let campus = args.campus ?? (mode === "sign-in" ? carried?.campus ?? "" : "");
  if (plan.askCampus && preset?.campusPrompt) {
    console.log(dim("  Several campuses share this Brightspace site."));
    while (!campus) {
      campus = await ask(rl, `${preset.campusPrompt} `);
      if (!campus) console.log(yellow("  Campus is required for automatic sign-in."));
    }
    console.log(dim(`  → ${campus}`));
    console.log("");
  }

  // ── Step 2: Username ─────────────────────────────────────────────
  let username = knownUsername ?? "";
  if (plan.askUsername) {
    const usernamePrompt = preset
      ? `What is your ${preset.usernameLabel}? `
      : "What username do you use to sign in to Brightspace? ";
    if (preset?.usernameHint) {
      console.log(dim(`  ${preset.usernameHint}`));
    } else {
      console.log(dim("  The same username you type on your school's Brightspace sign-in page."));
    }
    while (!username) {
      username = await ask(rl, usernamePrompt);
      if (!username) {
        console.log(yellow("  Username is required."));
      }
    }
  } else {
    console.log(dim(`  Username: ${username}`));
  }
  // The saved spelling of the same account still finds what 4.0.0 saved.
  username = savedUsername(saved && sameSchool(saved.baseUrl, baseUrl) ? saved.username : undefined, username);
  console.log("");

  // ── Step 3: Password (hidden) ────────────────────────────────────
  let keepPassword = false;
  if (plan.password === "keep-or-ask") {
    const answer = await ask(rl, `  A password is already saved for ${username}. Keep it? (yes/no) [yes]: `);
    keepPassword = !answer || /^y(es)?$/i.test(answer);
    console.log("");
  }

  // Close the rl temporarily since askPassword manages its own
  rl.close();

  let password = "";
  if (!keepPassword) {
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
  console.log("  How do you confirm it's you when you sign in?");
  console.log("    1. With a phone app: I tap Approve or type a code (recommended)");
  console.log("    2. Another way, like a text message: show me the sign-in page");
  const savedHeadless = saved?.headless;
  const savedRememberMfa = saved?.rememberMfa;
  const defaultMfaChoice = savedHeadless === false ? "2" : "1";
  let mfaChoice = "";
  while (!/^[12]$/.test(mfaChoice)) {
    mfaChoice = await ask(rl2, `  Choose 1 or 2 [${defaultMfaChoice}]: `) || defaultMfaChoice;
    if (!/^[12]$/.test(mfaChoice)) console.log(yellow("  Please enter 1 or 2."));
  }
  const headless = mfaChoice !== "2";
  console.log(dim(headless
    ? "  Sign-in will run in the background."
    : "  The sign-in page will open when you sign in here, so you can finish it yourself."));
  console.log("");

  // ── Step 4b: How often to approve (the one 2FA question) ─────────
  // Opt-in only: the default asks every time, and a shared computer must never
  // skip MFA unless asked to. Asked for every school and mode today; the
  // sign-in flow itself decides at run time whether a code can be typed.
  let keySaved = false;
  try {
    keySaved = Boolean(await getStoredTotpUri(baseUrl, username));
  } catch {
    // An unreadable credential store means there is nothing we can offer to remove.
  }
  const toneOf = { plain: (l: string) => l, dim, warn: yellow };
  const shortcutIO: ShortcutIO = {
    ask: (prompt) => ask(rl2, prompt),
    // The hidden prompt manages its own readline, so the shared one steps aside.
    async askSecret(prompt) {
      rl2.close();
      try {
        return await askPassword(prompt);
      } finally {
        rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      }
    },
    print: (line, tone = "plain") => console.log(toneOf[tone](line)),
  };
  const shortcuts = await askShortcutQuestion(shortcutIO, {
    username,
    rememberMfa: savedRememberMfa === true,
    keySaved,
    savedConfig: savedRememberMfa !== undefined || keySaved || savedHeadless !== undefined,
  });
  const rememberMfa = shortcuts?.rememberMfa;
  const totpUri = shortcuts?.totpUri;
  console.log("");

  // ── Step 5: Save config ──────────────────────────────────────────
  const config = buildConfigToSave(readExistingConfig(), {
    baseUrl,
    username,
    // Undefined when the saved one is kept: the credential store is left alone.
    password: password || undefined,
    totpUri,
    headless,
    rememberMfa,
    campus: campus || undefined,
  });

  await saveSecureConfig(config);
  console.log(green(keepPassword
    ? "  Kept the password already saved in your operating system credential store."
    : "  Password saved in your operating system credential store."));
  if (totpUri) console.log(green("  Authenticator enrollment saved in your operating system credential store."));
  if (shortcuts?.removeKey) {
    try {
      await deleteStoredTotpUri(baseUrl, username);
      console.log(green("  Saved authenticator key removed from your operating system credential store."));
    } catch {
      console.log(yellow("  Could not remove the saved authenticator key. Delete the brightspace-mcp-server entries from your computer's password store."));
    }
  }
  console.log(green("  Config saved to: " + getConfigStorePath()));
  console.log("");

  // ── Step 6: AI apps ──────────────────────────────────────────────
  // Before signing in, so someone who stops at the approval step still has
  // the server registered, and the next question in their AI app signs in.
  if (plan.registerApps) {
    for (const target of detectMcpClients()) {
      const answer = await ask(rl2, target.question);
      if (/^y(es)?$/i.test(answer) && await registerWithClient(target, (question) => ask(rl2, question))) {
        configuredClients.push(target.name);
      }
      console.log("");
    }
    printChatGPTInstructions();
  }

  // ── Step 7: Sign in ──────────────────────────────────────────────
  const retry = signInCommand(baseUrl);
  let signInNow = true;
  if (plan.confirmSignIn) {
    const authNow = await ask(rl2, "Sign in now, so everything is ready to go? (yes/no): ");
    signInNow = /^y(es)?$/i.test(authNow);
  }
  rl2.close();
  let signedIn = false;
  if (signInNow) {
    console.log("");
    console.log(dim("  Signing you in..."));
    console.log("");
    signedIn = await runAuth();
    if (signedIn) {
      console.log(green("\n  Signed in!"));
    } else {
      console.log(yellow(`\n  Sign-in didn't finish. To try again, run: ${retry}`));
    }
  } else {
    console.log(dim(`  You can sign in later by running: ${retry}`));
  }
  console.log("");

  // Sign-in mode exists to sign in, so it reports done only once that worked.
  if (mode === "sign-in" && !signedIn) {
    process.exitCode = 1;
    return;
  }

  // ── Final summary ────────────────────────────────────────────────
  console.log(bold("Setup complete!"));
  console.log("");
  console.log(`  Config saved to: ${dim(getConfigStorePath())}`);
  console.log("");
  console.log("  Next steps:");
  if (mode === "sign-in") {
    console.log("  1. Go back to your AI app. If it was open while setup ran, restart it.");
    console.log(`  2. Ask it: "What's due this week?"`);
  } else if (configuredClients.length > 0) {
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

async function main(): Promise<void> {
  const parsed = parseSetupArgs();
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error("");
    console.error(SETUP_USAGE);
    process.exitCode = 2;
    return;
  }
  const args = parsed.args;
  if (args.help) {
    console.log(SETUP_USAGE);
    return;
  }
  if (args.mode === "prepare") {
    await prepare(args);
    return;
  }
  // The wizard and sign-in wait for typing. Without a terminal (an agent's
  // shell, a pipe) they would hang, so say what to run instead.
  if (!process.stdin.isTTY) {
    console.error("Setup asks questions, so it has to run in a terminal someone can type in.");
    const school = args.preset?.baseUrl ?? (args.url && isValidUrl(normalizeUrl(args.url)) ? normalizeUrl(args.url) : undefined);
    console.error(`An AI agent should run ${prepareCommand(school)} instead, then have the person run the sign-in command it prints.`);
    process.exitCode = 2;
    return;
  }
  await interactive(args);
}

// Both entry points — the `brightspace-setup` bin and `brightspace-mcp-server
// setup`, which imports this module — start setup here. VITEST is set only by
// the test runner, which imports the module for the helpers above and must not
// open prompts on stdin; no user environment sets it.
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error("Setup failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
