/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * Find every copy of this package on the machine and report disagreement.
 *
 * A single machine can easily hold several copies at different versions: one
 * per Node version under a version manager, one per npx cache entry, plus a
 * local checkout. They are installed at different times and nothing keeps them
 * in step. The failure that motivated this had a v2.0.0 MCP server running
 * happily while the auth command typed in a shell resolved to v1.2.6, whose
 * sign-in flow no longer worked, with no way to see the mismatch.
 *
 * This scan needs no network, so unlike the registry check it still works
 * offline, and it catches the problem before anything fails rather than after.
 *
 * It reads package.json files and resolves symlinks. It never spawns a
 * process, never runs npm, and never writes anything.
 */

import { readFile, readdir, realpath as fsRealpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { PACKAGE_NAME, GLOBAL_INSTALL_COMMAND, AUTH_COMMAND } from "./commands.js";

/** Whole-scan budget. A stalled network mount on PATH must not hang startup. */
const SCAN_BUDGET_MS = 2000;

export interface InstallSite {
  kind: "global" | "npx-cache" | "self";
  /** The package directory, i.e. .../node_modules/brightspace-mcp-server */
  dir: string;
  version: string | null;
  /** The PATH entry that resolves here, when a shell command points at it. */
  binPath?: string;
  isSelf: boolean;
}

export interface InstallScanDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execPath?: string;
  home?: string;
  /** The running package directory, excluded from "other copies". */
  selfDir?: string;
  readVersion?: (packageJsonPath: string) => Promise<string | null>;
  listDir?: (dir: string) => Promise<string[]>;
  realpath?: (path: string) => Promise<string>;
}

async function defaultReadVersion(packageJsonPath: string): Promise<string | null> {
  try {
    const raw = await readFile(packageJsonPath, "utf-8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

async function defaultListDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Global `node_modules` roots to probe.
 *
 * A plain PATH scan is not enough. A GUI-launched MCP client inherits a
 * minimal launchd PATH with no version-manager directory in it, so the stale
 * copy would be invisible. Version-manager roots are therefore enumerated
 * directly, which is what surfaces a copy sitting under a different Node
 * version than the one currently running.
 */
async function candidateGlobalRoots(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  execPath: string,
  home: string,
  listDir: (dir: string) => Promise<string[]>
): Promise<string[]> {
  const roots = new Set<string>();
  const isWin = platform === "win32";

  // npm's own global-prefix rule, relative to the running node binary.
  roots.add(isWin
    ? join(dirname(execPath), "node_modules")
    : join(dirname(dirname(execPath)), "lib", "node_modules"));

  // Anything on PATH that looks like a bin directory.
  for (const entry of (env.PATH ?? "").split(isWin ? ";" : ":")) {
    if (!entry) continue;
    if (isWin) roots.add(join(entry, "node_modules"));
    else if (entry.endsWith(`${sep}bin`)) roots.add(join(dirname(entry), "lib", "node_modules"));
  }

  if (env.npm_config_prefix) {
    roots.add(isWin
      ? join(env.npm_config_prefix, "node_modules")
      : join(env.npm_config_prefix, "lib", "node_modules"));
  }

  if (isWin) {
    if (env.APPDATA) roots.add(join(env.APPDATA, "npm", "node_modules"));
  } else {
    roots.add("/usr/local/lib/node_modules");
    roots.add("/opt/homebrew/lib/node_modules");
  }

  // Version managers, one listing each.
  const managers: Array<[string, string[]]> = [
    [join(home, ".nvm", "versions", "node"), ["lib", "node_modules"]],
    [join(home, ".volta", "tools", "image", "node"), ["lib", "node_modules"]],
    [join(home, ".local", "share", "fnm", "node-versions"), ["installation", "lib", "node_modules"]],
    [join(home, ".asdf", "installs", "nodejs"), ["lib", "node_modules"]],
  ];
  for (const [base, tail] of managers) {
    for (const version of await listDir(base)) {
      roots.add(join(base, version, ...tail));
    }
  }

  return [...roots];
}

/**
 * Every copy of this package we can find, including the running one.
 * Never throws; anything unreadable is simply omitted.
 */
export async function scanInstallSites(deps: InstallScanDeps = {}): Promise<InstallSite[]> {
  const {
    env = process.env,
    platform = process.platform,
    execPath = process.execPath,
    home = homedir(),
    selfDir,
    readVersion = defaultReadVersion,
    listDir = defaultListDir,
    realpath = fsRealpath,
  } = deps;

  const found = new Map<string, InstallSite>();

  const record = async (dir: string, kind: InstallSite["kind"], binPath?: string) => {
    const key = resolve(dir);
    const version = await readVersion(join(key, "package.json"));
    if (version === null && !found.has(key)) return; // nothing actually installed here
    const isSelf = selfDir !== undefined && resolve(selfDir) === key;
    const existing = found.get(key);
    found.set(key, {
      kind: isSelf ? "self" : kind,
      dir: key,
      version: version ?? existing?.version ?? null,
      binPath: binPath ?? existing?.binPath,
      isSelf,
    });
  };

  const work = (async () => {
    const roots = await candidateGlobalRoots(env, platform, execPath, home, listDir);
    await Promise.allSettled(roots.map((root) => record(join(root, PACKAGE_NAME), "global")));

    // Which copy does the command a user actually types resolve to?
    const isWin = platform === "win32";
    if (!isWin) {
      const shims = ["brightspace-auth", PACKAGE_NAME];
      const pathEntries = (env.PATH ?? "").split(":").filter(Boolean);
      await Promise.allSettled(shims.map(async (shim) => {
        for (const entry of pathEntries) {
          const binPath = join(entry, shim);
          try {
            const target = await realpath(binPath);
            const marker = `${sep}node_modules${sep}${PACKAGE_NAME}${sep}`;
            const idx = target.indexOf(marker);
            if (idx === -1) continue;
            await record(target.slice(0, idx + marker.length - 1), "global", binPath);
            return;
          } catch {
            // No such shim here.
          }
        }
      }));
    }

    // npx cache entries.
    const npxRoot = join(home, ".npm", "_npx");
    await Promise.allSettled(
      (await listDir(npxRoot)).map((entry) =>
        record(join(npxRoot, entry, "node_modules", PACKAGE_NAME), "npx-cache")
      )
    );
  })();

  await Promise.race([
    work,
    new Promise<void>((r) => setTimeout(r, SCAN_BUDGET_MS).unref?.()),
  ]);

  return [...found.values()];
}

/**
 * Scan and format in one step. Returns null when there is nothing to say, and
 * never throws, so callers can treat it as advisory.
 *
 * Honors D2L_NO_UPDATE_CHECK, which switches off every version-related notice.
 */
export async function detectSkew(
  runningVersion: string,
  deps: InstallScanDeps = {}
): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (env.D2L_NO_UPDATE_CHECK) return null;
  try {
    const sites = await scanInstallSites(deps);
    return formatSkewNotice(sites, runningVersion, deps.home ?? homedir());
  } catch {
    return null;
  }
}

function shorten(path: string, home: string): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * A warning about shell-resolved copies that disagree with the running
 * version, or null when there is nothing worth saying.
 *
 * Dormant installs under inactive Node versions and old npx cache entries are
 * harmless. Only report a mismatch when a command the user can type currently
 * resolves to that copy.
 */
export function formatSkewNotice(
  sites: InstallSite[],
  runningVersion: string,
  home: string = homedir()
): string | null {
  const mismatched = sites
    .filter((s) =>
      !s.isSelf &&
      s.binPath !== undefined &&
      s.version !== null &&
      s.version !== runningVersion
    );

  if (mismatched.length === 0) return null;

  const lines = mismatched.map(
    (s) => `  - \`${shorten(s.binPath!, home)}\` resolves to v${s.version}`
  );

  return [
    `Version mismatch. This process is v${runningVersion}, but other copies of ${PACKAGE_NAME} are installed:`,
    ...lines,
    `An out-of-date auth CLI fails during sign-in. Run \`${GLOBAL_INSTALL_COMMAND}\`, or use \`${AUTH_COMMAND}\`.`,
  ].join("\n");
}
