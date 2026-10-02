#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * `doctor` — a beginner-facing diagnostic. It runs a fixed, ordered list of
 * checks (Node version, saved setup, credential store, school reachability,
 * saved sign-in, one real API call, installed version) and prints one line
 * per check: a checkmark plus a short description, or a cross plus exactly
 * one plain-English next step.
 *
 * Every check after "setup found" depends on the ones before it, so a
 * missing config or a broken sign-in is reported once, with everything
 * downstream marked "skipped" instead of printing a cascade of confusing
 * errors for the same root cause.
 *
 * Like `setup` and `auth`, this never prints a secret: no password, token,
 * or cookie value appears in any line.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import {
  configStoreExists,
  loadConfigStore,
  type ConfigStoreData,
} from "./utils/config-store.js";
import { accountSessionDirectory, expandTilde, readEnvSecret, parseSessionCookieEnv } from "./utils/config.js";
import { getStoredPassword } from "./auth/credential-store.js";
import { discoverVersions } from "./api/version-discovery.js";
import { TokenManager, type TokenManagerOptions } from "./auth/token-manager.js";
import { SessionStore } from "./auth/session-store.js";
import type { TokenData } from "./types/index.js";
import { D2LApiClient } from "./api/client.js";
import {
  fetchLatestVersion,
  isNewerVersion,
  safeVersionLabel,
  installKindOf,
  type InstallKind,
} from "./utils/update-checker.js";
import {
  SETUP_COMMAND,
  AUTH_COMMAND,
  GLOBAL_INSTALL_COMMAND,
  CLEAR_NPX_CACHE_COMMAND,
} from "./utils/commands.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readInstalledVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * doctor only ever reads a saved session — it must never write session.json,
 * trash it, or take the write lock a v1-record migration uses (that lock can
 * also throw AuthenticationInProgressError while a real sign-in holds it).
 * SessionStore.peek() is the read-only sibling of load() that does none of
 * that, so every write-shaped method here is a no-op and load() delegates to
 * peek() instead of the real load(). Exported for tests, which pass a fake
 * in place of a real SessionStore to prove the no-op wiring.
 */
export function readOnlySessionStore(store: Pick<SessionStore, "peek">): NonNullable<TokenManagerOptions["sessionStore"]> {
  return {
    load: () => store.peek(),
    save: async () => {},
    clear: async () => {},
    saveIfCurrent: async () => true,
    clearIfCurrent: async () => true,
  };
}

/** A TokenManager that can mint from a saved cookie but can never write, clear, or migrate session.json. */
function readOnlyTokenManager(baseUrl: string, sessionDir: string, envAccessToken?: string, envSessionCookie?: string): TokenManager {
  return new TokenManager({
    baseUrl,
    envAccessToken,
    envSessionCookie,
    sessionStore: readOnlySessionStore(new SessionStore(sessionDir)),
  });
}

// ── Types ─────────────────────────────────────────────────────────────

export type CheckId = "node" | "config" | "credential" | "network" | "session" | "courses" | "version";

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /** The full printable line, including its ✓/✗ prefix. */
  line: string;
}

export interface DoctorResult {
  checks: CheckResult[];
  allOk: boolean;
}

/**
 * Every external dependency doctor touches, as an injectable seam. Each
 * default below is the real implementation; tests override only the ones
 * relevant to the scenario under test, the same way
 * registerGetServerInfo injects readSignedInIdentity.
 */
export interface DoctorDeps {
  nodeVersion: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  configStoreExists: () => boolean;
  loadConfigStore: () => ConfigStoreData;
  getStoredPassword: (baseUrl: string, username: string) => Promise<string | null>;
  discoverVersions: (baseUrl: string) => Promise<unknown>;
  /**
   * Reuses TokenManager — disk (read-only) and, at most, one HTTP mint. Never
   * a browser, and never a write. envAccessToken/envSessionCookie bypass disk
   * entirely, same as the real server.
   */
  getSessionToken: (baseUrl: string, sessionDir: string, envAccessToken?: string, envSessionCookie?: string) => Promise<TokenData | null>;
  /**
   * One real course-list call, the same request get_my_courses makes — but
   * only the first page, since a diagnostic doesn't need every one. `hasMore`
   * says whether Brightspace reported additional pages.
   */
  countCourses: (baseUrl: string, sessionDir: string, envAccessToken?: string, envSessionCookie?: string) => Promise<{ count: number; hasMore: boolean }>;
  fetchLatestVersion: () => Promise<string | null>;
  installKind: InstallKind;
  installedVersion: string;
}

function defaultDoctorDeps(): DoctorDeps {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    env: process.env,
    configStoreExists,
    loadConfigStore,
    getStoredPassword,
    discoverVersions,
    getSessionToken: (baseUrl, sessionDir, envAccessToken, envSessionCookie) =>
      readOnlyTokenManager(baseUrl, sessionDir, envAccessToken, envSessionCookie).getToken(),
    countCourses: async (baseUrl, sessionDir, envAccessToken, envSessionCookie) => {
      const apiClient = new D2LApiClient({
        baseUrl,
        tokenManager: readOnlyTokenManager(baseUrl, sessionDir, envAccessToken, envSessionCookie),
      });
      const coursesPath = apiClient.lp("/enrollments/myenrollments/?orgUnitTypeId=3");
      const response = await apiClient.get<{ Items?: unknown[] | null; PagingInfo?: { HasMoreItems?: boolean | null } | null }>(coursesPath);
      return { count: response?.Items?.length ?? 0, hasMore: Boolean(response?.PagingInfo?.HasMoreItems) };
    },
    fetchLatestVersion,
    installKind: installKindOf(),
    installedVersion: readInstalledVersion(),
  };
}

function pass(id: CheckId, message: string): CheckResult {
  return { id, ok: true, line: `✓ ${message}` };
}

function problem(id: CheckId, message: string): CheckResult {
  return { id, ok: false, line: `✗ ${message}` };
}

// ── Individual checks ────────────────────────────────────────────────

function checkNode(deps: DoctorDeps): CheckResult {
  const major = Number(deps.nodeVersion.replace(/^v/, "").split(".")[0]);
  if (Number.isFinite(major) && major >= 20) {
    return pass("node", `Node.js ${deps.nodeVersion} (20 or newer)`);
  }
  return problem(
    "node",
    `Node.js ${deps.nodeVersion} is too old — install Node 20 or newer from https://nodejs.org/, then try again.`
  );
}

interface ConfigCheckOk {
  ok: true;
  result: CheckResult;
  baseUrl: string;
  /** Absent when D2L_USERNAME isn't set and config.json has none — valid when an env credential supplies sign-in instead. */
  username?: string;
  sessionDir: string;
  envAccessToken?: string;
  envSessionCookie?: string;
}
interface ConfigCheckFail {
  ok: false;
  result: CheckResult;
}
type ConfigCheck = ConfigCheckOk | ConfigCheckFail;

/**
 * Checks the resolved configuration — config.json AND the same env overrides
 * loadConfig() honours (D2L_BASE_URL, D2L_USERNAME, D2L_ACCESS_TOKEN,
 * D2L_SESSION_COOKIE) — since a Docker/headless setup legitimately has no
 * config.json at all and is configured entirely through the environment.
 * "Neither config.json nor the environment says anything" is the single most
 * common first-run state for everyone else.
 */
function checkConfig(deps: DoctorDeps): ConfigCheck {
  let store: ConfigStoreData | null = null;
  try {
    if (deps.configStoreExists()) store = deps.loadConfigStore();
  } catch {
    store = null;
  }

  let envAccessToken: string | undefined;
  let envSessionCookie: string | undefined;
  try {
    envAccessToken = readEnvSecret(deps.env.D2L_ACCESS_TOKEN, "D2L_ACCESS_TOKEN");
    const rawCookie = readEnvSecret(deps.env.D2L_SESSION_COOKIE, "D2L_SESSION_COOKIE");
    envSessionCookie = rawCookie ? parseSessionCookieEnv(rawCookie) : undefined;
  } catch (error) {
    return {
      ok: false,
      result: problem("config", error instanceof Error ? error.message : "D2L_ACCESS_TOKEN or D2L_SESSION_COOKIE is malformed."),
    };
  }

  const rawBaseUrl = deps.env.D2L_BASE_URL || store?.baseUrl;
  const username = deps.env.D2L_USERNAME || store?.username;
  const hasEnvCredential = Boolean(envAccessToken || envSessionCookie);

  // A username is required only for the normal stored-password flow: an env
  // credential signs in on its own and never needs one.
  if (!rawBaseUrl || (!username && !hasEnvCredential)) {
    return { ok: false, result: problem("config", `No setup found — run: ${SETUP_COMMAND}`) };
  }

  let baseUrl: string;
  try {
    baseUrl = new URL(rawBaseUrl).origin;
  } catch {
    return { ok: false, result: problem("config", `The configured Brightspace URL is invalid — run: ${SETUP_COMMAND}`) };
  }

  const sessionRoot = deps.env.D2L_SESSION_DIR
    ? expandTilde(deps.env.D2L_SESSION_DIR)
    : store?.sessionDir
      ? expandTilde(store.sessionDir)
      : path.join(os.homedir(), ".d2l-session");
  const sessionDir = accountSessionDirectory(sessionRoot, baseUrl, username);

  const label = username ? `signed in as ${username} at ${baseUrl}` : `configured for ${baseUrl} via environment variables`;
  return {
    ok: true,
    result: pass("config", `Setup found — ${label}`),
    baseUrl,
    username,
    sessionDir,
    envAccessToken,
    envSessionCookie,
  };
}

async function checkCredential(
  deps: DoctorDeps,
  baseUrl: string,
  username: string | undefined,
  envAccessToken: string | undefined,
  envSessionCookie: string | undefined
): Promise<CheckResult> {
  // Never print the value — only which variable is supplying it.
  if (envAccessToken) return pass("credential", "Signed in via the D2L_ACCESS_TOKEN environment variable (no password needed)");
  if (envSessionCookie) return pass("credential", "Signed in via the D2L_SESSION_COOKIE environment variable (no password needed)");
  if (!username) return problem("credential", `No username configured — run: ${SETUP_COMMAND}`);

  try {
    const password = await deps.getStoredPassword(baseUrl, username);
    if (password) return pass("credential", "Password saved in your operating system's credential store");
    return problem("credential", `No saved password found for this account — run: ${SETUP_COMMAND}`);
  } catch (error) {
    // On Linux the store itself (secret-tool / an unlocked Secret Service)
    // is usually the problem, and the thrown error already explains that in
    // plain English. Elsewhere, re-running setup is the one fix that covers
    // every native-store failure a student could hit.
    if (deps.platform === "linux") {
      return problem("credential", error instanceof Error ? error.message : "The Linux credential store is locked or unavailable. Unlock your keyring and try again.");
    }
    return problem("credential", `Run setup again: ${SETUP_COMMAND}`);
  }
}

async function checkNetwork(deps: DoctorDeps, baseUrl: string): Promise<CheckResult> {
  try {
    await deps.discoverVersions(baseUrl);
    return pass("network", `${baseUrl} is reachable`);
  } catch {
    return problem(
      "network",
      `Could not reach ${baseUrl} — check your internet connection and the school address, then run doctor again.`
    );
  }
}

interface SessionCheckOk {
  ok: true;
  result: CheckResult;
}
interface SessionCheckFail {
  ok: false;
  result: CheckResult;
}

async function checkSession(
  deps: DoctorDeps,
  baseUrl: string,
  sessionDir: string,
  envAccessToken: string | undefined,
  envSessionCookie: string | undefined
): Promise<SessionCheckOk | SessionCheckFail> {
  const failMessage = `No working saved sign-in — open your AI app and ask a question to sign in, or run: ${AUTH_COMMAND}`;
  try {
    const token = await deps.getSessionToken(baseUrl, sessionDir, envAccessToken, envSessionCookie);
    if (token) return { ok: true, result: pass("session", "Saved sign-in works — a token was issued without opening a browser") };
    return { ok: false, result: problem("session", failMessage) };
  } catch {
    return { ok: false, result: problem("session", failMessage) };
  }
}

/**
 * Trims an upstream error message down to something safe to show a beginner:
 * a 403/404 body can be a whole HTML page, and either way the raw text can
 * carry the endpoint URL. Collapses newlines, drops URLs, and caps length.
 */
function sanitizeErrorDetail(message: string): string {
  const noUrls = message.replace(/https?:\/\/\S+/gi, "");
  const singleLine = noUrls.replace(/\s+/g, " ").trim();
  const LIMIT = 120;
  return singleLine.length > LIMIT ? `${singleLine.slice(0, LIMIT).trimEnd()}…` : singleLine;
}

async function checkCourses(
  deps: DoctorDeps,
  baseUrl: string,
  sessionDir: string,
  envAccessToken: string | undefined,
  envSessionCookie: string | undefined
): Promise<CheckResult> {
  try {
    const { count, hasMore } = await deps.countCourses(baseUrl, sessionDir, envAccessToken, envSessionCookie);
    const label = hasMore ? `at least ${count}` : `${count}`;
    return pass("courses", `Found ${label} course${count === 1 ? "" : "s"} on Brightspace`);
  } catch (error) {
    const detail = error instanceof Error ? sanitizeErrorDetail(error.message) : "an unknown error";
    return problem("courses", `Could not load your courses (${detail}) — run doctor again after checking your connection.`);
  }
}

async function checkVersion(deps: DoctorDeps): Promise<CheckResult> {
  let latest: string | null = null;
  try {
    latest = await deps.fetchLatestVersion();
  } catch {
    latest = null;
  }

  const sourceNote = deps.installKind === "source-checkout" ? " (source checkout)" : "";

  // Offline, or the registry hiccuped: never treat "couldn't check" as a
  // failure — there is nothing actionable to tell a student here.
  if (latest === null) {
    return pass(
      "version",
      `Running v${safeVersionLabel(deps.installedVersion)}${sourceNote} — could not check for a newer version (you may be offline)`
    );
  }

  if (!isNewerVersion(latest, deps.installedVersion)) {
    return pass("version", `Running the latest version (v${safeVersionLabel(deps.installedVersion)})${sourceNote}`);
  }

  const from = safeVersionLabel(deps.installedVersion);
  const to = safeVersionLabel(latest);
  const nextStep =
    deps.installKind === "source-checkout"
      ? "pull the latest changes and run npm run build"
      : deps.installKind === "npm-install"
        ? `run: ${GLOBAL_INSTALL_COMMAND}`
        : `it updates automatically next time, or run: ${CLEAR_NPX_CACHE_COMMAND}`;
  return problem("version", `A newer version is available (v${from} to v${to}) — ${nextStep}.`);
}

// ── Orchestration ────────────────────────────────────────────────────

/** Human-readable name for each check, used to prefix its "Skipped" line. */
const CHECK_NAMES: Record<CheckId, string> = {
  node: "Node.js version",
  config: "Setup",
  credential: "Credential store",
  network: "Brightspace reachability",
  session: "Saved sign-in",
  courses: "Course list",
  version: "Version",
};

const SKIPPED_SETUP = `finish setup first, then run doctor again: ${SETUP_COMMAND}`;
const SKIPPED_SESSION = "fix the saved sign-in step above first, then run doctor again.";

function skip(id: CheckId, reason: string): CheckResult {
  return problem(id, `${CHECK_NAMES[id]}: Skipped — ${reason}`);
}

export async function runDoctorChecks(overrides: Partial<DoctorDeps> = {}): Promise<DoctorResult> {
  const deps: DoctorDeps = { ...defaultDoctorDeps(), ...overrides };
  const checks: CheckResult[] = [];

  checks.push(checkNode(deps));

  const config = checkConfig(deps);
  checks.push(config.result);

  if (!config.ok) {
    checks.push(skip("credential", SKIPPED_SETUP));
    checks.push(skip("network", SKIPPED_SETUP));
    checks.push(skip("session", SKIPPED_SETUP));
    checks.push(skip("courses", SKIPPED_SETUP));
  } else {
    checks.push(await checkCredential(deps, config.baseUrl, config.username, config.envAccessToken, config.envSessionCookie));
    checks.push(await checkNetwork(deps, config.baseUrl));

    const session = await checkSession(deps, config.baseUrl, config.sessionDir, config.envAccessToken, config.envSessionCookie);
    checks.push(session.result);

    if (session.ok) {
      checks.push(await checkCourses(deps, config.baseUrl, config.sessionDir, config.envAccessToken, config.envSessionCookie));
    } else {
      checks.push(skip("courses", SKIPPED_SESSION));
    }
  }

  checks.push(await checkVersion(deps));

  return { checks, allOk: checks.every((c) => c.ok) };
}

// ── CLI entry point ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const result = await runDoctorChecks();

  console.log("");
  console.log("Brightspace MCP Server — doctor");
  console.log("");
  for (const check of result.checks) console.log(`  ${check.line}`);
  console.log("");
  console.log(
    result.allOk
      ? "Everything looks good — open your AI app and ask a question."
      : "Fix the ✗ items above, then run doctor again."
  );
  console.log("");

  process.exitCode = result.allOk ? 0 : 1;
}

// VITEST is set only by the test runner, which imports this module for the
// functions above and must never run the real checks against this machine.
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error("doctor failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
