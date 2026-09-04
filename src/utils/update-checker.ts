/**
 * Background npm update checker: look, and tell, but never touch.
 *
 * On startup the server asks the npm registry for the latest published
 * version. If it is newer than the running one, the user is told how to
 * update. Nothing is ever installed by this module. The one side effect it
 * keeps is scoped to this package's own stale npx cache directories, because
 * clearing them is what lets `npx brightspace-mcp-server@latest` actually
 * pick up the new version on the next start.
 *
 * Set D2L_NO_UPDATE_CHECK to any value to switch the check off entirely.
 */

import { readFileSync } from "node:fs";
import { access, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";

const PACKAGE_NAME = "brightspace-mcp-server";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const REGISTRY_TIMEOUT_MS = 5000;

const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), "..", "..");

let notice: string | null = null;

function getInstalledVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function isNpxCache(): boolean {
  const normalized = projectRoot.split(sep).join("/");
  return /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]brightspace-mcp-server/.test(normalized);
}

/**
 * Remove every npx cache entry that holds a copy of this package, so the next
 * `npx brightspace-mcp-server@latest` downloads the new version instead of
 * reusing a stale one. Touches nothing outside those directories.
 */
async function clearAllNpxCaches(): Promise<number> {
  const npxCacheRoot = resolve(homedir(), ".npm", "_npx");
  let cleared = 0;
  try {
    for (const entry of await readdir(npxCacheRoot)) {
      const entryDir = resolve(npxCacheRoot, entry);
      try {
        await access(resolve(entryDir, "node_modules", PACKAGE_NAME));
        await rm(entryDir, { recursive: true, force: true });
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
    clearCaches = clearAllNpxCaches,
  } = deps;

  if (env.D2L_NO_UPDATE_CHECK) return;

  try {
    const response = await fetchImpl(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) return;

    const latest = ((await response.json()) as { version?: unknown }).version;
    if (typeof latest !== "string" || !isNewerVersion(latest, installedVersion)) return;

    if (runningFromNpxCache) {
      const count = await clearCaches();
      notice =
        `Update available: v${installedVersion} to v${latest}. ` +
        `Cleared ${count} stale npx cache director${count === 1 ? "y" : "ies"} for ${PACKAGE_NAME} ` +
        `so the next start downloads v${latest}. Restart your MCP client to pick it up.`;
    } else {
      notice =
        `Update available: v${installedVersion} to v${latest}. ` +
        `Run: npx ${PACKAGE_NAME}@latest, or npm install -g ${PACKAGE_NAME}@latest`;
    }
  } catch {
    // A version check must never take the server down.
  }
}

export function getUpdateNotice(): string | null {
  const result = notice;
  notice = null;
  return result;
}
