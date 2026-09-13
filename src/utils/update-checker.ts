/**
 * Background npm update checker: look, and tell, but never touch.
 *
 * The server asks the npm registry for the latest published version, on
 * startup and then periodically, because a stdio MCP server can stay alive for
 * days and a boot-only check would never notice a release. If the registry has
 * something newer, the user is told how to update. Nothing is ever installed
 * by this module.
 *
 * The one side effect it keeps is scoped to this package's own stale npx cache
 * directories, because clearing them is what lets `npx brightspace-mcp-server@latest`
 * actually pick up the new version on the next start. It never deletes the
 * directory the current process is running from -- doing so pulls the rug out
 * from under lazy imports (Playwright is loaded on demand at auth time) and
 * from the auth CLI this process spawns as a child.
 *
 * The notice repeats on a throttle rather than being consumed by whichever
 * caller happens to read it first. A one-shot notice is invisible in practice:
 * it gets swallowed by a single background tool call and never seen again.
 *
 * Set D2L_NO_UPDATE_CHECK to any value to switch the check off entirely.
 */

import { readFileSync } from "node:fs";
import { access, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";
import {
  PACKAGE_NAME,
  GLOBAL_INSTALL_COMMAND,
  CLEAR_NPX_CACHE_COMMAND,
} from "./commands.js";

const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const REGISTRY_TIMEOUT_MS = 5000;

/** How long before the same notice is worth repeating to an MCP client. */
const NOTICE_REPEAT_MS = 30 * 60 * 1000;

/** How often a long-lived server re-asks the registry. */
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), "..", "..");

interface NoticeState {
  text: string;
  /** null until the notice has been handed to a throttled consumer. */
  lastShownAt: number | null;
}

let state: NoticeState | null = null;

function getInstalledVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The `_npx/<hash>` directory this process is executing out of, or null when
 * not running from an npx cache. Used both to detect npx execution and, more
 * importantly, to know which directory must never be deleted.
 */
export function ownNpxCacheDir(root: string = projectRoot): string | null {
  const normalized = root.split(sep).join("/");
  const match = new RegExp(`^(.*/_npx/[^/]+)/node_modules/${PACKAGE_NAME}`).exec(normalized);
  return match ? resolve(match[1]) : null;
}

function isNpxCache(): boolean {
  return ownNpxCacheDir() !== null;
}

/**
 * Remove npx cache entries holding a copy of this package, so the next
 * `npx brightspace-mcp-server@latest` downloads the new version instead of
 * reusing a stale one.
 *
 * Skips the directory the current process is running from. Deleting it would
 * break this process: Playwright is imported lazily at auth time, and the auth
 * CLI is spawned from the same tree, so both would fail with ENOENT for the
 * rest of the server's life. Touches nothing outside npx cache directories.
 */
export async function clearAllNpxCaches(
  selfDir: string | null = ownNpxCacheDir(),
  deps: { readdirImpl?: typeof readdir; rmImpl?: typeof rm; accessImpl?: typeof access } = {}
): Promise<number> {
  const { readdirImpl = readdir, rmImpl = rm, accessImpl = access } = deps;
  const npxCacheRoot = resolve(homedir(), ".npm", "_npx");
  let cleared = 0;
  try {
    for (const entry of await readdirImpl(npxCacheRoot)) {
      const entryDir = resolve(npxCacheRoot, entry);
      if (selfDir && entryDir === selfDir) continue; // never saw off the branch we sit on
      try {
        await accessImpl(resolve(entryDir, "node_modules", PACKAGE_NAME));
        await rmImpl(entryDir, { recursive: true, force: true });
        cleared++;
      } catch {
        // Not one of ours, leave it alone.
      }
    }
  } catch {
    // No npx cache, or not readable. Nothing to clear.
  }
  return cleared;
}

function parseTriple(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True only when `latest` is strictly newer than `installed`, compared as
 * numeric major, minor, patch. Prerelease suffixes are ignored, and anything
 * that does not parse as a version is never "newer", so a registry hiccup
 * cannot announce an update that does not exist.
 */
export function isNewerVersion(latest: string, installed: string): boolean {
  const a = parseTriple(latest);
  const b = parseTriple(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Ask the registry for the latest published version. Returns null on any
 * failure -- a bad network must never be reported as "you are up to date" or
 * as an error the caller has to handle.
 */
export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const latest = ((await response.json()) as { version?: unknown }).version;
    return typeof latest === "string" ? latest : null;
  } catch {
    return null;
  }
}

export interface UpdateCheckDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  installedVersion?: string;
  runningFromNpxCache?: boolean;
  clearCaches?: () => Promise<number>;
}

/**
 * Run one update check. Never throws and never blocks the caller for long:
 * the registry request is bounded by a timeout and every failure is
 * swallowed, because a version check must not affect the server.
 */
export async function initUpdateChecker(deps: UpdateCheckDeps = {}): Promise<void> {
  const {
    fetchImpl = fetch,
    env = process.env,
    installedVersion = getInstalledVersion(),
    runningFromNpxCache = isNpxCache(),
    clearCaches = () => clearAllNpxCaches(),
  } = deps;

  if (env.D2L_NO_UPDATE_CHECK) return;

  try {
    const latest = await fetchLatestVersion(fetchImpl);
    if (latest === null || !isNewerVersion(latest, installedVersion)) return;

    const headline = `Update available: v${installedVersion} to v${latest}.`;
    let text: string;

    if (runningFromNpxCache) {
      const count = await clearCaches();
      const cleanup = count > 0
        ? `Cleared ${count} stale npx cache director${count === 1 ? "y" : "ies"} for ${PACKAGE_NAME} ` +
          `(kept the one this server is running from). `
        : "";
      text = `${headline} ${cleanup}Restart your MCP client to pick up v${latest}.`;
    } else {
      text = `${headline} Run: ${GLOBAL_INSTALL_COMMAND}` +
        `, then ${CLEAR_NPX_CACHE_COMMAND} and restart your MCP client.`;
    }

    // Preserve lastShownAt when the text is unchanged, so a periodic re-check
    // does not reset the throttle and start repeating the same line.
    state = state?.text === text ? state : { text, lastShownAt: null };
  } catch {
    // A version check must never take the server down.
  }
}

export interface PeriodicUpdateDeps extends UpdateCheckDeps {
  intervalMs?: number;
  setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void };
  clearIntervalImpl?: (handle: unknown) => void;
}

/**
 * Check now, then keep checking. Returns a stop function.
 *
 * The interval is unref'd so it can never hold a stdio server open past the
 * point it would otherwise exit.
 */
export function startUpdateChecks(deps: PeriodicUpdateDeps = {}): () => void {
  const {
    intervalMs = DEFAULT_CHECK_INTERVAL_MS,
    setIntervalImpl = setInterval as unknown as (fn: () => void, ms: number) => { unref?: () => void },
    clearIntervalImpl = clearInterval as unknown as (handle: unknown) => void,
    ...checkDeps
  } = deps;

  void initUpdateChecker(checkDeps);

  const handle = setIntervalImpl(() => {
    void initUpdateChecker(checkDeps);
  }, intervalMs);
  handle.unref?.();

  return () => clearIntervalImpl(handle);
}

/**
 * Read the notice without consuming or throttling it.
 *
 * For one-shot contexts like a CLI, which runs, prints once, and exits.
 */
export function peekUpdateNotice(): string | null {
  return state?.text ?? null;
}

/**
 * Read the notice for a repeated context like MCP tool responses, which can
 * fire many times a session. Returns the notice at most once per
 * `minIntervalMs`. `now` is a parameter so throttling is testable without
 * faking timers.
 */
export function getUpdateNotice(
  now: number = Date.now(),
  minIntervalMs: number = NOTICE_REPEAT_MS
): string | null {
  if (!state) return null;
  if (state.lastShownAt !== null && now - state.lastShownAt < minIntervalMs) return null;
  state.lastShownAt = now;
  return state.text;
}

/** Drop any pending notice. Primarily for resetting module state in tests. */
export function clearUpdateNotice(): void {
  state = null;
}
