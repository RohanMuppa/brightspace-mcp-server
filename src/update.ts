#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 */

import { execSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ quiet: true } as Parameters<typeof dotenv.config>[0]);

// ANSI color helpers
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: opts?.silent ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
    }).trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    throw new Error(error.stderr || error.message || "Command failed");
  }
}

function getVersion(): string {
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
  return pkg.version || "unknown";
}

/** Compare two directories as the filesystem sees them. */
export function samePath(a: string, b: string): boolean {
  const canonical = (p: string) => {
    let full = resolve(p);
    try {
      full = realpathSync(full);
    } catch {
      // A path that cannot be resolved is compared as written.
    }
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  return canonical(a) === canonical(b);
}

/** Stop before anything is modified, saying why and what to do. */
function refuse(reason: string, remedy: string): never {
  console.error(red(`  Error: ${reason}`));
  console.error(`  ${remedy}`);
  process.exit(1);
}

export type ReleaseChoice =
  | { ok: true; version: string; commit: string }
  | { ok: false; reason: string };

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function versionTriple(version: string): [number, number, number] | null {
  const m = STABLE_VERSION.exec(version.trim().replace(/^v/, ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareTriples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Whether `nodeVersion` meets an `engines.node` range. Only plain
 * comparator sets (">=20.0.0", ">=20 <23") are understood; anything else
 * yields null so the caller refuses instead of guessing.
 */
function satisfiesNodeRange(range: string, nodeVersion: string): boolean | null {
  const have = versionTriple(nodeVersion);
  const comparators = range.trim().split(/\s+/);
  if (!have || comparators.length === 0) return null;
  for (const comparator of comparators) {
    const m = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
    if (!m) return null;
    const want: [number, number, number] = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
    const cmp = compareTriples(have, want);
    const ok = { ">=": cmp >= 0, "<=": cmp <= 0, ">": cmp > 0, "<": cmp < 0, "=": cmp === 0 }[m[1] ?? "="];
    if (!ok) return false;
  }
  return true;
}

/**
 * Decide which commit a checkout should move to, from what npm reports as the
 * `latest` release. Only a stable version, published from a known commit, whose
 * Node.js requirement this runtime meets, is a target; anything else is refused
 * so the update fails closed.
 */
export function chooseRelease(registry: unknown, nodeVersion: string): ReleaseChoice {
  const info = (registry ?? {}) as { version?: unknown; gitHead?: unknown; engines?: { node?: unknown } };
  const { version, gitHead } = info;
  if (typeof version !== "string" || !versionTriple(version)) {
    return { ok: false, reason: "npm did not report a stable release version." };
  }
  if (typeof gitHead !== "string" || !COMMIT_SHA.test(gitHead)) {
    return { ok: false, reason: `npm does not record which commit ${version} was published from.` };
  }
  const nodeRange = info.engines?.node;
  if (nodeRange !== undefined) {
    const satisfied = typeof nodeRange === "string" ? satisfiesNodeRange(nodeRange, nodeVersion) : null;
    if (satisfied === null) {
      return { ok: false, reason: `Cannot check ${version}'s Node.js requirement (${String(nodeRange)}).` };
    }
    if (!satisfied) {
      return { ok: false, reason: `${version} requires Node.js ${nodeRange}; this is Node.js ${nodeVersion}.` };
    }
  }
  return { ok: true, version, commit: gitHead };
}

function fail(...lines: string[]): void {
  console.error(red(`  Error: ${lines[0]}`));
  for (const line of lines.slice(1)) console.error(`  ${line}`);
  process.exit(1);
}

export function main(): void {
  console.log("");
  console.log(bold("=== Brightspace MCP Server — Update ==="));
  console.log("");

  // Check if we're in a git repo
  let toplevel: string;
  try {
    toplevel = run("git rev-parse --show-toplevel", { silent: true });
  } catch {
    console.error(red("Error: Not a git repository. Cannot update."));
    console.error("Make sure you cloned this project with git.");
    process.exit(1);
    return;
  }

  // Git answers for the nearest enclosing repository, which for an installed
  // copy under node_modules is the *user's own* project. Fetching and pulling
  // origin/main there would rewrite a repository that has nothing to do with
  // this package, so only a checkout that is itself the repository root is
  // updated.
  if (!samePath(toplevel, projectRoot)) {
    console.error(red("Error: This copy is not a git checkout of brightspace-mcp-server."));
    console.error(`  It lives in ${projectRoot}, inside the repository at ${toplevel}.`);
    console.error("  Update an installed copy with npm instead; this command is for a git clone.");
    process.exit(1);
    return;
  }

  // Show current version
  const currentVersion = getVersion();
  console.log(`  Current version: ${bold(currentVersion)}`);
  console.log("");

  // The update fast-forwards the checked-out branch to origin/main, so it only
  // runs where that cannot touch local work: a clean working tree on main.
  const status = run("git status --porcelain", { silent: true });
  if (status) {
    refuse("You have uncommitted changes.", "Commit or stash them, then run the update again.");
  }
  const branch = run("git branch --show-current", { silent: true });
  if (branch !== "main") {
    refuse(
      branch ? `You are on branch '${branch}', not main.` : "HEAD is detached, not on main.",
      "Run 'git switch main', then run the update again.",
    );
  }

  // Resolve the latest published release: the checkout follows what npm
  // ships, never the unreleased tip of main.
  console.log(dim("  Checking the latest release on npm..."));
  let registry: unknown;
  try {
    registry = JSON.parse(run("npm view brightspace-mcp-server@latest version gitHead engines --json", { silent: true }));
  } catch {
    fail("Could not read the latest release from npm.", "Check your network connection and try again.");
    return;
  }
  const release = chooseRelease(registry, process.version);
  if (!release.ok) {
    fail("No release this checkout can safely update to.", release.reason);
    return;
  }
  const { version: targetVersion, commit } = release;

  // Fetch, then confirm the published commit really is that release on main.
  console.log(dim(`  Fetching release ${targetVersion}...`));
  try {
    run("git fetch origin main", { silent: true });
  } catch {
    fail("Failed to fetch from remote.", "Check your network connection and try again.");
    return;
  }
  try {
    run(`git merge-base --is-ancestor ${commit} origin/main`, { silent: true });
    const released = JSON.parse(run(`git show ${commit}:package.json`, { silent: true })) as { version?: unknown };
    if (released.version !== targetVersion) throw new Error("version mismatch");
  } catch {
    fail(`Could not verify release ${targetVersion} (commit ${commit.slice(0, 7)}) on origin/main.`, "Nothing was changed.");
    return;
  }

  // Local commits on main that origin/main lacks would need a merge or rebase.
  const aheadCount = run("git rev-list --count origin/main..HEAD", { silent: true });
  if (aheadCount !== "0") {
    refuse(
      `Your main has ${aheadCount} commit${aheadCount === "1" ? "" : "s"} that origin/main does not.`,
      "Move them to another branch or reconcile main with origin/main yourself, then run the update again.",
    );
  }

  // Check if we're behind
  const behindCount = run(`git rev-list --count HEAD..${commit}`, { silent: true });
  if (behindCount === "0") {
    console.log("");
    console.log(green("  Already up to date!"));
    console.log("");
    return;
  }

  // Show what's new
  console.log("");
  console.log(bold(`  ${behindCount} new commit${behindCount === "1" ? "" : "s"} in ${targetVersion}:`));
  console.log("");
  const log = run(`git log HEAD..${commit} --oneline`, { silent: true });
  for (const line of log.split("\n")) {
    console.log(`    ${dim("•")} ${line}`);
  }
  console.log("");

  // Fast-forward only, to the verified release: never a merge or rebase,
  // whatever git's pull settings say, and no pull fallback if it fails.
  console.log(dim(`  Updating to ${targetVersion}...`));
  try {
    run(`git merge --ff-only ${commit}`, { silent: true });
  } catch {
    fail(`Could not fast-forward to ${targetVersion}.`, "Nothing was changed. Check 'git status' and try again.");
    return;
  }

  // Install dependencies
  console.log(dim("  Installing dependencies..."));
  try {
    run("npm install", { silent: true });
  } catch {
    console.error(red("  Error: Failed to install dependencies."));
    process.exit(1);
  }

  // Build
  console.log(dim("  Building..."));
  try {
    run("npm run build", { silent: true });
  } catch {
    console.error(red("  Error: Build failed."));
    process.exit(1);
  }

  // Show new version
  const newVersion = getVersion();
  console.log("");
  console.log(green("  Update complete!"));
  if (newVersion !== currentVersion) {
    console.log(`  Version: ${currentVersion} → ${bold(newVersion)}`);
  }
  console.log("");
  console.log("  Restart your MCP client to use the latest version.");
  console.log("");
}

// `npm run update` runs this file directly. VITEST is set only by the test
// runner, which imports the module to exercise main() against a stubbed git;
// no user environment sets it.
if (!process.env.VITEST) {
  main();
}
