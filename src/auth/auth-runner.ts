/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { log } from "../utils/logger.js";

/**
 * Timeout for the auth process. It has to outlast the child's own MFA wait,
 * which is five minutes: a person has to find their phone, unlock it, and read
 * a number off the screen. A shorter parent budget would kill the child in the
 * middle of a sign-in the user was still completing.
 */
const AUTH_TIMEOUT_MS = 6 * 60 * 1000; // 6 minutes

/**
 * Forward a child stream to the server log, one line at a time.
 *
 * The child writes its progress to stderr, including Entra's number-match
 * digits, which the user cannot complete a sign-in without. Discarding the
 * stream, as this used to, made an auto-reauth impossible to finish.
 */
function forwardLines(
  stream: Readable | null,
  emit: (line: string) => void
): void {
  if (!stream) return;
  let buffered = "";
  stream.setEncoding("utf-8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) emit(line.trimEnd());
    }
  });
  stream.on("end", () => {
    if (buffered.trim()) emit(buffered.trimEnd());
    buffered = "";
  });
}

/**
 * Launches the brightspace-auth CLI as a child process to
 * re-authenticate when the current session has expired.
 *
 * The child process inherits the parent's environment (so .env credentials
 * are available via dotenv in the auth CLI) and runs with the project root
 * as CWD (so dotenv can find the .env file).
 */
export class AuthRunner {
  private running = false;
  private readonly scriptPath: string;
  private readonly projectRoot: string;

  constructor() {
    // Resolve paths relative to this file's compiled location (build/auth/auth-runner.js)
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    this.scriptPath = path.resolve(thisDir, "..", "auth-cli.js");
    this.projectRoot = path.resolve(thisDir, "..", "..");
  }

  /**
   * Spawn the auth CLI and wait for it to complete.
   * Returns true if authentication succeeded, false otherwise.
   * Prevents concurrent auth attempts via a simple mutex.
   */
  async run(): Promise<boolean> {
    if (this.running) {
      log("DEBUG", "Auth already running, skipping duplicate attempt");
      return false;
    }

    this.running = true;
    try {
      log("INFO", "Auto-launching brightspace-auth...");

      return await new Promise<boolean>((resolve) => {
        const child = spawn(
          process.execPath, // use the same Node binary
          [this.scriptPath],
          {
            cwd: this.projectRoot,
            env: { ...process.env },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, AUTH_TIMEOUT_MS);

        forwardLines(child.stderr, (line) => log("INFO", line));
        // Piped and drained rather than ignored: a full stdout pipe would
        // block the child mid-login.
        forwardLines(child.stdout, (line) => log("DEBUG", line));

        child.on("error", (error) => {
          clearTimeout(timer);
          log("ERROR", "Auto-auth process failed", error.message);
          resolve(false);
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (timedOut) {
            log("ERROR", `Auto-auth timed out after ${AUTH_TIMEOUT_MS / 60000} minutes`);
            resolve(false);
          } else if (code === 0) {
            log("INFO", "Auto-auth completed successfully");
            resolve(true);
          } else {
            log("ERROR", `Auto-auth process failed with exit code ${code}`);
            resolve(false);
          }
        });
      });
    } finally {
      this.running = false;
    }
  }
}
