#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ quiet: true } as Parameters<typeof dotenv.config>[0]);

// ANSI color helpers
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
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
    // tsc reports compile errors on stdout and npm adds its summary on
    // stderr, so a failure keeps both.
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const output = [error.stdout, error.stderr].filter((s) => s?.trim()).join("\n");
    throw new Error(output || error.message || "Command failed");
  }
}

/** How many trailing lines of a failed command's output are worth showing. */
const FAILURE_TAIL_LINES = 20;

/**
 * The end of a failed command's output, fit for a terminal: escape sequences
 * and control characters stripped, blank lines dropped, long logs cut to the
 * last few lines (where npm and tsc put the actual error).
 */
export function failureDetail(err: unknown): string[] {
  const text = err instanceof Error ? err.message : String(err);
  const lines = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  return lines.slice(-FAILURE_TAIL_LINES);
}

/** Print a failed step with its cause and how to recover, then exit. */
function fail(summary: string, err: unknown, recovery: string[]): void {
  console.error(red(`  Error: ${summary}`));
  const detail = failureDetail(err);
  if (detail.length > 0) {
    console.error("");
    for (const line of detail) console.error(dim(`    ${line}`));
    console.error("");
  }
  for (const line of recovery) console.error(`  ${line}`);
  process.exit(1);
}

const RETRY_HINT = [
  "The update is not finished. Fix the problem above, then run `npm run update` again;",
  "it will redo the install and build even though the new code is already pulled.",
];

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

  // Check for uncommitted changes
  const status = run("git status --porcelain", { silent: true });
  if (status) {
    console.log(yellow("  Warning: You have uncommitted changes."));
    console.log(dim("  The update will proceed, but your local changes may conflict."));
    console.log("");
  }

  // Fetch latest from remote
  console.log(dim("  Fetching latest changes..."));
  try {
    run("git fetch origin main", { silent: true });
  } catch (err) {
    fail("Failed to fetch from remote.", err, ["Check your network connection and try again."]);
    return;
  }

  // A marker in the git directory records that the code was pulled but the
  // install or build has not yet succeeded. Without it a retry would see no
  // new commits and report "Already up to date" over a broken build.
  const marker = resolve(projectRoot, run("git rev-parse --git-path brightspace-update-incomplete", { silent: true }));
  const unfinished = existsSync(marker);

  const behindCount = run("git rev-list --count HEAD..origin/main", { silent: true });
  if (behindCount === "0" && !unfinished) {
    console.log("");
    console.log(green("  Already up to date!"));
    console.log("");
    return;
  }

  if (behindCount === "0") {
    console.log(yellow("  The last update did not finish. Finishing it now."));
  } else {
    // Show what's new
    console.log("");
    console.log(bold(`  ${behindCount} new commit${behindCount === "1" ? "" : "s"}:`));
    console.log("");
    const log = run("git log HEAD..origin/main --oneline", { silent: true });
    for (const line of log.split("\n")) {
      console.log(`    ${dim("•")} ${line}`);
    }
    console.log("");

    writeFileSync(marker, `${new Date().toISOString()}\n`);

    // Pull changes
    console.log(dim("  Pulling changes..."));
    try {
      run("git pull origin main", { silent: true });
    } catch (err) {
      fail("Failed to pull changes.", err, [
        "You may have merge conflicts. Resolve them manually and try again.",
      ]);
      return;
    }
  }

  // Install dependencies
  console.log(dim("  Installing dependencies..."));
  try {
    run("npm install", { silent: true });
  } catch (err) {
    fail("Failed to install dependencies.", err, [
      "If a file is locked (EBUSY/EPERM), close every MCP client using this server first.",
      ...RETRY_HINT,
    ]);
    return;
  }

  // Build
  console.log(dim("  Building..."));
  try {
    run("npm run build", { silent: true });
  } catch (err) {
    fail("Build failed.", err, RETRY_HINT);
    return;
  }

  rmSync(marker, { force: true });

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
