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
  } catch {
    console.error(red("  Error: Failed to fetch from remote."));
    console.error("  Check your network connection and try again.");
    process.exit(1);
  }

  // Check if we're behind
  const behindCount = run("git rev-list --count HEAD..origin/main", { silent: true });
  if (behindCount === "0") {
    console.log("");
    console.log(green("  Already up to date!"));
    console.log("");
    return;
  }

  // Show what's new
  console.log("");
  console.log(bold(`  ${behindCount} new commit${behindCount === "1" ? "" : "s"}:`));
  console.log("");
  const log = run("git log HEAD..origin/main --oneline", { silent: true });
  for (const line of log.split("\n")) {
    console.log(`    ${dim("•")} ${line}`);
  }
  console.log("");

  // Pull changes
  console.log(dim("  Pulling changes..."));
  try {
    run("git pull origin main", { silent: true });
  } catch {
    console.error(red("  Error: Failed to pull changes."));
    console.error("  You may have merge conflicts. Resolve them manually and try again.");
    process.exit(1);
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
