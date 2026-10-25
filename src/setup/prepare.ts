/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * `setup --prepare`: every install step an AI agent can do on its own, so the
 * person is needed only for the last one (their password and sign-in
 * approval). It never reads stdin, never reads or writes a password, and
 * never starts a sign-in. Safe to run again: a second run changes nothing.
 */

import { spawnSync } from "node:child_process";
import { nodeVersionSupported, readSavedSessionToken, sessionDirFor } from "../utils/saved-session.js";
import { discoverVersions } from "../api/version-discovery.js";
import type { TokenData } from "../types/index.js";
import type { ConfigStoreData } from "../utils/config-store.js";
import { getConfigStorePath } from "../utils/config-store.js";
import { saveSecureConfig } from "../utils/secure-config.js";
import {
  chromiumReady,
  chromiumStatus,
  dependencyRepairHint,
  installChromium,
  PLAYWRIGHT_INSTALL_HINT,
  type ChromiumStatus,
} from "../utils/browser-install.js";
import { DOCTOR_COMMAND, prepareCommand, signInCommand } from "../utils/commands.js";
import { runCommandWithoutPrompts } from "../utils/mcp-client-cli.js";
import type { SetupArgs } from "./args.js";
import { buildConfigToSave, isValidUrl, normalizeUrl, readExistingConfig, sameSchool } from "./config.js";
import { detectMcpClients, registerAll, type McpClientTarget, type RegistrationOutcome } from "./clients.js";
import { presetForBaseUrl } from "./presets.js";

export type PrepareState = "ready_for_sign_in" | "signed_in" | "needs_input" | "blocked";

export interface PrepareStep {
  id: "node" | "school" | "credential-store" | "browser" | "network" | "settings" | "app" | "session";
  ok: boolean;
  /** A failed blocking step means sign-in can't work until it is fixed. */
  blocking: boolean;
  line: string;
}

export interface PrepareResult {
  state: PrepareState;
  school?: { baseUrl: string; name?: string };
  steps: PrepareStep[];
  apps: RegistrationOutcome[];
  /** Apps that only see the server after a restart. */
  restart: string[];
  next: { command?: string; needsHuman: boolean; instructions: string };
}

export interface PrepareDeps {
  nodeVersion: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  readExistingConfig: () => ConfigStoreData | null;
  saveSecureConfig: (config: ConfigStoreData) => Promise<void>;
  configPath: () => string;
  probeCredentialStore: (platform: NodeJS.Platform) => { ok: boolean; line: string };
  discoverVersions: (baseUrl: string) => Promise<unknown>;
  chromiumStatus: () => Promise<ChromiumStatus>;
  installChromium: () => Promise<{ ok: boolean; message?: string }>;
  detectClients: () => McpClientTarget[];
  getSessionToken: (baseUrl: string, sessionDir: string) => Promise<TokenData | null>;
  /** Progress lines while a step runs (the Chromium download). */
  progress: (line: string) => void;
}

/**
 * Whether the native credential store can be used, without unlocking or
 * reading anything: a keychain read on macOS can pop an "allow access" dialog
 * and a Linux lookup can ask to unlock the keyring, and prepare must never
 * stop for the person. The store is really used at sign-in, which says so if
 * it is locked.
 */
export function probeCredentialStore(platform: NodeJS.Platform): { ok: boolean; line: string } {
  if (platform === "darwin") return { ok: true, line: "Passwords will be kept in the macOS Keychain" };
  if (platform === "win32") return { ok: true, line: "Passwords will be kept in Windows Credential Manager" };
  if (platform !== "linux") return { ok: false, line: `No supported credential store on ${platform}` };
  // `search` without --unlock only lists, and stdout is discarded: for an
  // unlocked item it would include the secret itself.
  const result = spawnSync("secret-tool", ["search", "--all", "service", "brightspace-mcp-server"], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 10_000,
  });
  if (result.error) {
    return { ok: false, line: "secret-tool is not installed — install libsecret-tools (Debian/Ubuntu) or your distribution's libsecret tools" };
  }
  if (result.status !== 0) {
    return { ok: false, line: "The Secret Service isn't running — unlock your desktop keyring, then run prepare again" };
  }
  return { ok: true, line: "Passwords will be kept in the Secret Service (libsecret)" };
}

function defaultPrepareDeps(json: boolean): PrepareDeps {
  const progress = json ? (line: string) => console.error(line) : (line: string) => console.log(line);
  return {
    nodeVersion: process.version,
    platform: process.platform,
    env: process.env,
    readExistingConfig,
    saveSecureConfig,
    configPath: getConfigStorePath,
    probeCredentialStore,
    discoverVersions,
    chromiumStatus: () => chromiumStatus(),
    installChromium: () => installChromium(),
    detectClients: () => detectMcpClients({ runCommand: runCommandWithoutPrompts, warn: progress }),
    getSessionToken: (baseUrl, sessionDir) => readSavedSessionToken(baseUrl, sessionDir),
    progress,
  };
}

/** Key order doesn't matter when deciding whether the saved settings changed. */
function sameSettings(a: ConfigStoreData | null, b: ConfigStoreData): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([k, v]) => [k, canonical(v)]),
        )
        : value;
  return a !== null && JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const ok = (id: PrepareStep["id"], line: string, blocking = true): PrepareStep => ({ id, ok: true, blocking, line: `✓ ${line}` });
const fail = (id: PrepareStep["id"], line: string, blocking = true): PrepareStep => ({ id, ok: false, blocking, line: `✗ ${line}` });

function appLine(outcome: RegistrationOutcome): PrepareStep {
  switch (outcome.outcome) {
    case "added":
      return ok("app", `${outcome.name}: Brightspace added`, false);
    case "replaced":
      return ok("app", `${outcome.name}: old "brightspace" entry replaced`, false);
    case "current":
      return ok("app", `${outcome.name}: already set up`, false);
    case "shared_http":
      return ok("app", `${outcome.name}: already set up to use the shared server at ${outcome.url}`, false);
    case "different_left":
      return fail("app", `${outcome.name}: "brightspace" already runs ${outcome.current} — left as is (pass --replace to change it)`, false);
    case "failed":
      return fail("app", `${outcome.name}: could not register (${outcome.message})`, false);
  }
}

export async function runPrepare(args: SetupArgs, overrides: Partial<PrepareDeps> = {}): Promise<PrepareResult> {
  const deps: PrepareDeps = { ...defaultPrepareDeps(args.json), ...overrides };
  const steps: PrepareStep[] = [];

  // ── Node ──
  steps.push(nodeVersionSupported(deps.nodeVersion)
    ? ok("node", `Node.js ${deps.nodeVersion} (22 or newer)`)
    : fail("node", `Node.js ${deps.nodeVersion} is too old — install Node 22 or newer from https://nodejs.org/`));

  // ── School ──
  const existing = deps.readExistingConfig();
  let baseUrl: string | undefined;
  let invalidUrl = false;
  let schoolName: string | undefined;
  if (args.preset) {
    baseUrl = args.preset.baseUrl;
    schoolName = args.preset.name;
  } else if (args.url) {
    const normalized = normalizeUrl(args.url);
    if (isValidUrl(normalized)) baseUrl = new URL(normalized).origin;
    else invalidUrl = true;
    if (invalidUrl) steps.push(fail("school", `"${args.url}" isn't a valid Brightspace address — pass it like --url purdue.brightspace.com`));
  } else if (existing?.baseUrl) {
    baseUrl = existing.baseUrl;
  }
  if (baseUrl) {
    schoolName ??= presetForBaseUrl(baseUrl)?.preset.name;
    steps.push(ok("school", schoolName ? `School: ${schoolName} (${baseUrl})` : `School: ${baseUrl}`));
  } else if (!args.url) {
    steps.push(fail("school", "No school given — pass your school's flag (for example --purdue) or --url <your Brightspace address>"));
  }

  // ── Credential store ──
  const store = deps.probeCredentialStore(deps.platform);
  steps.push(store.ok ? ok("credential-store", store.line) : fail("credential-store", store.line));

  // ── Chromium ──
  let browser = await deps.chromiumStatus();
  if (!chromiumReady(browser) && args.installBrowser && browser.headless !== "dependency_missing" && browser.headless !== "unknown") {
    deps.progress("  Downloading Chromium for sign-in (this can take a few minutes)...");
    const installed = await deps.installChromium();
    browser = installed.ok ? await deps.chromiumStatus() : browser;
    if (!installed.ok && installed.message) deps.progress(`  ${installed.message}`);
  }
  if (chromiumReady(browser)) {
    steps.push(ok("browser", "Chromium is installed for sign-in"));
  } else {
    steps.push(fail("browser", browser.headless === "dependency_missing" ? dependencyRepairHint()
      : browser.headless === "unknown" ? "Chromium's test launch failed. Check operating system permissions and browser system dependencies."
        : args.installBrowser
          ? `Chromium could not be installed. ${PLAYWRIGHT_INSTALL_HINT}`
          : "Chromium is missing — run prepare again without --no-browser-install"));
  }

  // ── Network, settings, session (need a school) ──
  let signedIn = false;
  if (baseUrl) {
    let reachable = true;
    try {
      await deps.discoverVersions(baseUrl);
      steps.push(ok("network", `${baseUrl} is reachable`));
    } catch {
      reachable = false;
      steps.push(fail("network", `Could not reach ${baseUrl} — check the internet connection and the school address`));
    }

    const carried = existing && sameSchool(existing.baseUrl, baseUrl) ? existing : null;
    const username = args.username ?? carried?.username;
    const campus = args.campus ?? carried?.campus;
    const config = buildConfigToSave(existing, {
      baseUrl,
      username: username ?? "",
      // No password: the keychain is left exactly as it is.
      password: undefined,
      headless: carried?.headless ?? true,
      rememberMfa: undefined,
      campus,
    });
    if (!username) delete config.username;
    // Never a secret: the keychain is the person's step, at sign-in.
    delete config.password;
    delete config.totpUri;

    const notes: string[] = [];
    if (carried?.username && args.username && carried.username !== config.username) {
      notes.push(`was ${carried.username}; sign-in starts fresh for the new account`);
    }
    if (!username) notes.push("sign-in will ask for the username");
    const preset = presetForBaseUrl(baseUrl)?.preset;
    if (preset?.campusPrompt && !campus) notes.push("sign-in will ask which campus");
    const noteText = notes.length ? ` (${notes.join("; ")})` : "";

    if (!reachable) {
      // A mistyped --url must not replace a working setup: nothing is saved
      // until the school answers.
      steps.push(fail("settings", "Settings not saved, because the school couldn't be reached — the saved setup is unchanged"));
    } else if (existing?.password) {
      // A password from before v2 still sits in config.json, and loading the
      // config moves it into the credential store. Rewriting the file here
      // would drop the only copy, so it is left exactly as it is.
      steps.push(ok("settings", "Settings left as they are: this computer still has a password from an older version, which the next sign-in moves to the credential store"));
    } else if (sameSettings(existing, config)) {
      steps.push(ok("settings", `Settings already saved, no password stored by prepare${noteText}`));
    } else {
      try {
        await deps.saveSecureConfig(config);
        steps.push(ok("settings", `Settings saved to ${deps.configPath()}, no password${noteText}`));
      } catch (error) {
        steps.push(fail("settings", `Could not save settings: ${error instanceof Error ? error.message : String(error)}`));
      }
    }

    if (username) {
      try {
        const token = await deps.getSessionToken(baseUrl, sessionDirFor(deps.env, config, baseUrl, config.username));
        signedIn = Boolean(token);
      } catch {
        signedIn = false;
      }
      steps.push(signedIn
        ? ok("session", "Already signed in — a saved sign-in still works", false)
        : ok("session", "Not signed in yet — that's the person's step", false));
    }
  }

  // ── AI apps ──
  const targets = deps.detectClients().filter((target) => target.detected);
  const apps = registerAll(targets, { replace: args.replace });
  steps.push(...apps.map(appLine));
  if (targets.length === 0) {
    steps.push(fail("app", "No supported AI app found — register `npx -y brightspace-mcp-server@latest` in your app by hand", false));
  }
  const restart = apps.filter((a) => a.outcome === "added" || a.outcome === "replaced").map((a) => a.name);

  // ── Outcome ──
  const blocked = steps.some((step) => !step.ok && step.blocking && step.id !== "school");
  const state: PrepareState = !baseUrl ? "needs_input" : blocked ? "blocked" : signedIn ? "signed_in" : "ready_for_sign_in";

  const restartText = restart.length ? `Restart ${restart.join(", ")} so it loads the server. ` : "";
  const next: PrepareResult["next"] =
    state === "ready_for_sign_in"
      ? {
        command: signInCommand(baseUrl),
        needsHuman: true,
        instructions:
          "Have the person run this in a terminal they can type in, not a background shell. It asks for their " +
          "password (shown as asterisks) and how they confirm sign-in, then waits for their approval on their phone. " +
          `It is finished when it prints "Setup complete!". Then run: ${DOCTOR_COMMAND} --json. ${restartText}`.trimEnd(),
      }
      : state === "signed_in"
        ? {
          command: `${DOCTOR_COMMAND} --json`,
          needsHuman: false,
          instructions: `Already signed in. ${restartText}Then ask it a question, such as "What's due this week?"`,
        }
        : state === "blocked"
          ? {
            command: prepareCommand(baseUrl),
            needsHuman: false,
            instructions: "Fix each ✗ step above, then run prepare again.",
          }
          : {
            needsHuman: true,
            instructions: invalidUrl
              ? "The address given with --url isn't a valid Brightspace address. Ask the person for the address they open to see their courses, then run prepare again with --url <that address>."
              : "Ask the person which school they're at, then run prepare again with its flag (for example --purdue) or --url <their Brightspace address>.",
          };

  return {
    state,
    ...(baseUrl ? { school: { baseUrl, ...(schoolName ? { name: schoolName } : {}) } } : {}),
    steps,
    apps,
    restart,
    next,
  };
}

/** The result as a person (or an agent without --json) reads it. */
export function formatPrepare(result: PrepareResult): string[] {
  const lines = ["", "Brightspace MCP Server — prepare", ""];
  for (const step of result.steps) lines.push(`  ${step.line}`);
  lines.push("");
  if (result.state === "ready_for_sign_in") {
    lines.push("Ready for sign-in. The last step is for the person, in a terminal:");
  } else if (result.state === "signed_in") {
    lines.push("Ready to use.");
  } else if (result.state === "blocked") {
    lines.push("Not ready yet.");
  } else {
    lines.push("Need the school first.");
  }
  if (result.next.command) lines.push(`  ${result.next.command}`);
  lines.push(`  ${result.next.instructions}`);
  lines.push("");
  return lines;
}
