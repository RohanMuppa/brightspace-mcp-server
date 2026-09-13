/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * Self-healing for the auth CLI.
 *
 * The MCP server is launched as `npx -y brightspace-mcp-server@latest`, so it
 * refetches on every client restart and is effectively always current. The
 * auth CLI has no such guarantee: a copy installed once with `npm install -g`
 * stays at that version forever. That is how a machine ended up running a
 * v2.0.0 server alongside a v1.2.6 auth CLI whose sign-in flow no longer
 * worked, with nothing to say so.
 *
 * When a stale CLI notices it is behind, it re-runs itself through
 * `npx -y brightspace-mcp-server@latest auth` and hands back that process's
 * exit code. The user types nothing and is not asked anything; the newest code
 * simply runs. Note this does not rewrite the old copy on disk -- it is
 * bypassed, not upgraded. Overwriting it would mean running `npm install -g`
 * from inside a live process, which is the thing this package deliberately
 * does not do.
 *
 * Opt out with D2L_NO_UPDATE_CHECK.
 */

import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import { PACKAGE_NAME } from "./commands.js";
import { fetchLatestVersion, isNewerVersion, ownNpxCacheDir } from "./update-checker.js";

/** Set in the child's environment so a re-exec can never recurse. */
export const REEXEC_SENTINEL = "D2L_REEXECED";

export interface ReexecDeps {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  installedVersion?: string;
  fetchImpl?: typeof fetch;
  /** npx already resolved @latest, so a re-exec would be pointless. */
  runningFromNpxCache?: boolean;
  platform?: NodeJS.Platform;
  spawnImpl?: (
    command: string,
    args: string[],
    options: SpawnOptions
  ) => ChildProcess;
}

/**
 * Flags worth carrying into the re-executed process. Only pass through
 * option flags: the subcommand is supplied explicitly, and forwarding stray
 * positional arguments risks changing what the child actually does.
 */
export function passthroughFlags(argv: string[]): string[] {
  return argv.slice(2).filter((arg) => arg.startsWith("-"));
}

/**
 * Decide, without doing anything, whether a re-exec is warranted.
 * Split out from the spawn so the policy is testable on its own.
 */
export function shouldReexec(opts: {
  env: NodeJS.ProcessEnv;
  latest: string | null;
  installedVersion: string;
  runningFromNpxCache: boolean;
}): boolean {
  const { env, latest, installedVersion, runningFromNpxCache } = opts;
  if (env[REEXEC_SENTINEL]) return false; // we are already the child
  if (env.D2L_NO_UPDATE_CHECK) return false;
  if (runningFromNpxCache) return false; // npx just fetched this
  if (latest === null) return false; // registry unreachable, carry on offline
  return isNewerVersion(latest, installedVersion);
}

/**
 * Re-run this command through the latest published release when the running
 * copy is stale.
 *
 * Resolves to the child's exit code when a re-exec happened (the caller should
 * exit with it and do no further work), or null when the current process
 * should simply continue.
 */
export async function reexecLatestIfStale(deps: ReexecDeps = {}): Promise<number | null> {
  const {
    env = process.env,
    argv = process.argv,
    installedVersion,
    fetchImpl = fetch,
    runningFromNpxCache = ownNpxCacheDir() !== null,
    platform = process.platform,
    spawnImpl = spawn,
  } = deps;

  if (installedVersion === undefined) return null;

  // Cheap local checks first, so an opted-out or npx-launched run never even
  // touches the network.
  if (env[REEXEC_SENTINEL] || env.D2L_NO_UPDATE_CHECK || runningFromNpxCache) return null;

  const latest = await fetchLatestVersion(fetchImpl);
  if (!shouldReexec({ env, latest, installedVersion, runningFromNpxCache })) return null;

  const args = ["-y", `${PACKAGE_NAME}@latest`, "auth", ...passthroughFlags(argv)];

  console.error(
    `\nThis copy is v${installedVersion}; v${latest} is available. ` +
    `Running the newer version instead.\n`
  );

  return await new Promise<number | null>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(platform === "win32" ? "npx.cmd" : "npx", args, {
        stdio: "inherit",
        env: { ...env, [REEXEC_SENTINEL]: "1" },
        shell: platform === "win32",
      });
    } catch {
      resolve(null); // could not launch npx, fall back to running ourselves
      return;
    }

    // If npx itself cannot start, run the stale copy rather than failing.
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
