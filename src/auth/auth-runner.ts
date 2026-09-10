/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { spawn, execFileSync } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { log } from "../utils/logger.js";
import { AuthError } from "../utils/errors.js";

/**
 * Timeout for the auth process. It has to outlast the child's own MFA wait,
 * which is five minutes: a person has to find their phone, unlock it, and read
 * a number off the screen. A shorter parent budget would kill the child in the
 * middle of a sign-in the user was still completing.
 */
const AUTH_TIMEOUT_MS = 8 * 60 * 1000;
const KILL_GRACE_MS = 5000;

export type AuthFailureKind = "busy" | "cooldown" | "unsupported" | "secureStorage" | "transport" | "timeout" | "failed";

export class AuthProcessError extends AuthError {
  constructor(public readonly kind: AuthFailureKind, message: string) {
    super(message);
    this.name = "AuthProcessError";
  }
}

export interface AuthRunnerOptions {
  timeoutMs?: number;
  onProgress?: (line: string) => void;
}

/** Chromium can lead a separate process group, so a forced stop needs its PID. */
function descendantPids(parentPid: number): number[] {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8", timeout: 1000,
  }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const descendants: number[] = [];
  const visited = new Set([parentPid]);
  const visit = (parent: number) => {
    for (const [pid, ppid] of rows) {
      if (ppid === parent && Number.isInteger(pid) && pid > 1 && !visited.has(pid)) {
        visited.add(pid);
        visit(pid);
        descendants.push(pid);
      }
    }
  };
  visit(parentPid);
  return descendants;
}

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
 * The child inherits the parent's resolved environment and working directory,
 * so both processes read the same account configuration and .env file.
 */
export class AuthRunner {
  /**
   * The login this process already started, if one is still running.
   *
   * Every tool call funnels here the moment the saved session is gone, and a
   * stdio MCP server serves tool calls concurrently. Without a latch, two cold
   * calls both see no token and both spawn a login: two browsers racing the
   * same cross-process lock, and at Purdue two Authenticator prompts on the
   * user's phone for one request. Holding the in-flight Promise makes every
   * caller await the same login and read the same outcome.
   */
  private inFlight: Promise<boolean> | null = null;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly onProgress?: (line: string) => void;

  constructor(options: AuthRunnerOptions = {}) {
    // Resolve paths relative to this file's compiled location (build/auth/auth-runner.js)
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    this.scriptPath = path.resolve(thisDir, "..", "auth-cli.js");
    this.timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS;
    this.onProgress = options.onProgress;
  }

  /**
   * Authenticate, joining the login this process already started if there is
   * one. Returns true on success and throws a useful error on failure.
   */
  async run(): Promise<boolean> {
    if (this.inFlight) {
      log("DEBUG", "Joining the authentication already in flight");
      return this.inFlight;
    }

    // The latch is released by the flow that owns it, as it settles, so a
    // failed login is never replayed: the tool call after a declined MFA
    // prompt starts a fresh attempt rather than inheriting the stale
    // rejection. Ownership is checked because a caller could in principle
    // clear the latch while this flow is still running.
    const flow = this.spawnAuth().finally(() => {
      if (this.inFlight === flow) this.inFlight = null;
    });
    this.inFlight = flow;
    return flow;
  }

  /** One child process, start to finish. */
  private async spawnAuth(): Promise<boolean> {
    log("INFO", "Auto-launching brightspace-auth...");

    return await new Promise<boolean>((resolve, reject) => {
      const child = spawn(
        process.execPath, // use the same Node binary
        [this.scriptPath, "--automatic"],
        {
          cwd: process.cwd(),
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );

      let timedOut = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform === "win32") {
            execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
              stdio: "ignore", timeout: 5000,
            });
          } else if (child.pid) {
            if (signal === "SIGKILL") {
              try {
                for (const pid of descendantPids(child.pid)) {
                  try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
                }
              } catch { /* Still terminate the owned process group if ps is unavailable. */ }
            }
            process.kill(-child.pid, signal);
          } else child.kill(signal);
        } catch {
          // The child may already have exited between close and cleanup.
        }
      };
      const onExit = () => kill("SIGTERM");
      process.once("exit", onExit);
      const finish = (error?: AuthProcessError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        process.off("exit", onExit);
        if (error) reject(error);
        else resolve(true);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill("SIGTERM");
        killTimer = setTimeout(() => {
          kill("SIGKILL");
          finish(new AuthProcessError("timeout", "Authentication timed out. Run brightspace-auth to try again."));
        }, KILL_GRACE_MS);
      }, this.timeoutMs);

      forwardLines(child.stderr, (line) => {
        log("INFO", line);
        try { this.onProgress?.(line); } catch { /* Logging must not interrupt authentication. */ }
      });
      // Piped and drained rather than ignored: a full stdout pipe would
      // block the child mid-login.
      forwardLines(child.stdout, (line) => log("DEBUG", line));

      child.on("error", (error) => {
        if (settled) return;
        log("ERROR", "Auto-auth process failed", error.message);
        kill("SIGKILL");
        finish(new AuthProcessError("failed", "Could not start authentication. Run brightspace-auth for details."));
      });

      child.on("close", (code) => {
        if (settled) return;
        if (timedOut) {
          kill("SIGKILL");
          finish(new AuthProcessError("timeout", "Authentication timed out. Run brightspace-auth to try again."));
        } else if (code === 0) {
          log("INFO", "Auto-auth completed successfully");
          finish();
        } else {
          const failures: Record<number, [AuthFailureKind, string]> = {
            2: ["busy", "Authentication already in progress in another process. Complete that attempt, then retry."],
            3: ["cooldown", "Automatic MFA is paused after an unsuccessful attempt. Run brightspace-auth to retry immediately."],
            4: ["unsupported", "This identity provider cannot complete headless authentication. See the authentication logs."],
            5: ["secureStorage", "The native credential store is unavailable or locked. Unlock it and retry."],
            6: ["transport", "Brightspace authentication is temporarily unavailable because of a network or server failure. Your saved session was preserved. Try again later."],
          };
          const [kind, message] = failures[code ?? -1] ?? ["failed", "Authentication failed. Run brightspace-auth to try again."];
          kill("SIGKILL");
          finish(new AuthProcessError(kind, message));
        }
      });
    });
  }
}
