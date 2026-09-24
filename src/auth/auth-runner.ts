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
import { AUTH_COMMAND } from "../utils/commands.js";

/**
 * Timeout for the auth process. It has to outlast the child's own MFA wait,
 * which is five minutes: a person has to find their phone, unlock it, and read
 * a number off the screen. A shorter parent budget would kill the child in the
 * middle of a sign-in the user was still completing. run() itself usually
 * returns long before this fires — the moment the child reports an MFA
 * challenge — but this timer keeps bounding the background child regardless.
 */
const AUTH_TIMEOUT_MS = 8 * 60 * 1000;
const KILL_GRACE_MS = 5000;

/**
 * How long a caller that joins a background child already reported as
 * mfaPending waits for it before re-answering with the same challenge.
 * Long enough for an already-approved login to finish its next ~2s poll and
 * mint a token; short enough that a not-yet-approved one still answers
 * within this tool call instead of blocking for the rest of the 5-minute
 * approval window.
 */
const JOIN_GRACE_MS = 5000;

/**
 * The only two lines auth-cli.ts is allowed to hand back as structured data.
 * Deliberately strict (whole line, 1-3 digits or the literal word) so this
 * can never become a channel for arbitrary child-process text to reach a
 * tool response — anything that doesn't match exactly is just another log
 * line.
 */
const MFA_NUMBER_MARKER = /^MFA_NUMBER:(\d{1,3})$/;
const MFA_PENDING_MARKER = /^MFA_PENDING$/;

/** The mfaPending kind and message, with or without number-match digits. */
function mfaPendingFailure(numberMatch: string | undefined): [AuthFailureKind, string] {
  return numberMatch
    ? ["mfaPending", `Open Microsoft Authenticator and enter ${numberMatch} within 5 minutes, then try again.`]
    : ["mfaPending", "An MFA approval was not completed in time. Try again."];
}

export type AuthFailureKind = "busy" | "cooldown" | "unsupported" | "secureStorage" | "transport" | "timeout" | "failed" | "mfaPending";

export class AuthProcessError extends AuthError {
  constructor(
    public readonly kind: AuthFailureKind,
    message: string,
    /**
     * Entra number-match digits, when the failure is "mfaPending". Crossed
     * the child process boundary as a strictly-matched stdout marker (see
     * MFA_NUMBER_MARKER below) — already bounded to 1-3 digits at the point
     * it was scraped from the page, so it is safe to surface verbatim.
     */
    public readonly numberMatch?: string,
  ) {
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
 *
 * run() settles as soon as the child reports an MFA challenge (with or
 * without a number to display) rather than waiting for the child to exit —
 * a tool call must not block for the whole approval window. The child keeps
 * running in the background; a later run() call joins that background child
 * instead of spawning a second one.
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
  /**
   * The child from a login that answered its caller early (an MFA challenge
   * was reported) and is still running in the background. Set for the
   * duration of every spawned child, not just the early-answer case, so a
   * caller who joins after the answer already exists resolves immediately.
   */
  private childDone: Promise<boolean> | null = null;
  /**
   * The last MFA challenge the current background child reported, if any.
   * Set the moment a marker settles a caller early, cleared alongside
   * childDone. Lets a later joiner re-answer immediately instead of
   * discovering the challenge is stale only after blocking on childDone.
   */
  private pendingChallenge: { numberMatch?: string } | null = null;
  /** Resolves on the next marker from the current child; null between children. */
  private challengeSignal: Promise<void> | null = null;
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

    // A caller that answered early is gone, but its child can still be
    // running in the background (waiting on the user's phone). Join it
    // instead of spawning a second child, which would only hit the
    // cross-process lock and return "busy".
    if (this.childDone) {
      log("DEBUG", "Joining the background sign-in still running from an earlier call");
      return this.joinBackgroundChild(this.childDone);
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

  /**
   * Join a background child from an earlier early-answered call instead of
   * spawning a new one. A joiner must not simply await childDone: that
   * blocks for whatever is left of the 5-minute approval window, exactly the
   * problem run() otherwise fixes, since the caller usually retries right
   * after reading "call this tool again" and well before actually approving.
   *
   * If no challenge has been reported yet (the child hasn't reached MFA),
   * wait for one — or for the child to finish on its own. Once a challenge
   * is known, race the child against a short grace window: fast enough for
   * an already-approved login to land, short enough to re-answer with the
   * same challenge rather than block.
   */
  private async joinBackgroundChild(childDone: Promise<boolean>): Promise<boolean> {
    if (!this.pendingChallenge && this.challengeSignal) {
      await Promise.race([childDone.catch(() => {}), this.challengeSignal]);
    }

    const challenge = this.pendingChallenge;
    if (!challenge) return childDone;

    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const graceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new AuthProcessError(...mfaPendingFailure(challenge.numberMatch), challenge.numberMatch));
      }, JOIN_GRACE_MS);
      graceTimer.unref?.();
      childDone.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(graceTimer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(graceTimer);
          reject(error);
        },
      );
    });
  }

  /**
   * One child process, start to finish. The returned promise can settle
   * before the child actually exits (see the stdout handler below); the
   * child's real completion is tracked separately on this.childDone.
   */
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
      // Whether the caller-facing promise above (resolve/reject) has
      // settled. Distinct from childFinished: an early MFA answer settles
      // this while the child keeps running.
      let callerSettled = false;
      // Whether the child has actually finished (exited, timed out, or
      // failed to start) and teardown has run. Guards every handler below
      // against double cleanup.
      let childFinished = false;
      let numberMatch: string | undefined;
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

      const settleCaller = (error?: AuthProcessError) => {
        if (callerSettled) return;
        callerSettled = true;
        if (error) reject(error);
        else resolve(true);
      };

      // Tracks the child to its real end, independent of an early caller
      // answer. Exposed as this.childDone so the next run() call can join
      // it. A dummy catch keeps an unapproved background failure from
      // becoming an unhandled rejection when nobody ever joins it; it does
      // not stop a later `await this.childDone` from seeing the rejection.
      let resolveChildDone!: (value: boolean) => void;
      let rejectChildDone!: (reason?: unknown) => void;
      const completion = new Promise<boolean>((res, rej) => {
        resolveChildDone = res;
        rejectChildDone = rej;
      });
      const trackedCompletion = completion.finally(() => {
        if (this.childDone === trackedCompletion) {
          this.childDone = null;
          this.pendingChallenge = null;
          this.challengeSignal = null;
        }
      });
      trackedCompletion.catch(() => { /* see comment above */ });
      this.childDone = trackedCompletion;
      this.pendingChallenge = null;
      let resolveChallengeSignal!: () => void;
      this.challengeSignal = new Promise<void>((res) => { resolveChallengeSignal = res; });

      // Records the challenge (number or not) and wakes a joiner waiting in
      // joinBackgroundChild. Idempotent on the "already known" question, but
      // a later number still overwrites a numberless pendingChallenge so a
      // fresh joiner sees it — see MFA_PENDING_MARKER's own comment.
      const publishChallenge = (matched: string | undefined) => {
        const firstChallenge = this.pendingChallenge === null;
        if (firstChallenge || matched) {
          this.pendingChallenge = { numberMatch: matched ?? this.pendingChallenge?.numberMatch };
        }
        if (firstChallenge) resolveChallengeSignal();
        if (!callerSettled) {
          settleCaller(new AuthProcessError(...mfaPendingFailure(this.pendingChallenge?.numberMatch), this.pendingChallenge?.numberMatch));
        }
      };

      // Runs once the child is actually done. Settles the caller too, if an
      // early answer had not already done so; otherwise this is just the
      // background sign-in finishing, which only childDone's joiner sees.
      const finishChild = (error?: AuthProcessError) => {
        if (childFinished) return;
        childFinished = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        process.off("exit", onExit);
        const answeredEarly = callerSettled;
        settleCaller(error);
        if (answeredEarly) {
          if (error) log("WARN", `Background sign-in finished with ${error.kind}: ${error.message}`);
          else log("INFO", "Background sign-in completed successfully after an early MFA response");
        }
        if (error) rejectChildDone(error);
        else resolveChildDone(true);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        kill("SIGTERM");
        killTimer = setTimeout(() => {
          kill("SIGKILL");
          finishChild(new AuthProcessError("timeout", `Authentication timed out. Run ${AUTH_COMMAND} to try again.`));
        }, KILL_GRACE_MS);
      }, this.timeoutMs);

      forwardLines(child.stderr, (line) => {
        log("INFO", line);
        try { this.onProgress?.(line); } catch { /* Logging must not interrupt authentication. */ }
      });
      // Piped and drained rather than ignored: a full stdout pipe would
      // block the child mid-login. The first marker settles the caller
      // immediately, without killing the child — see the class doc comment.
      forwardLines(child.stdout, (line) => {
        const numberMarker = MFA_NUMBER_MARKER.exec(line);
        if (numberMarker) {
          numberMatch = numberMarker[1];
          publishChallenge(numberMatch);
        } else if (MFA_PENDING_MARKER.test(line)) {
          publishChallenge(undefined);
        } else {
          log("DEBUG", line);
        }
      });

      child.on("error", (error) => {
        if (childFinished) return;
        log("ERROR", "Auto-auth process failed", error.message);
        kill("SIGKILL");
        finishChild(new AuthProcessError("failed", `Could not start authentication. Run ${AUTH_COMMAND} for details.`));
      });

      child.on("close", (code) => {
        if (childFinished) return;
        if (timedOut) {
          kill("SIGKILL");
          finishChild(new AuthProcessError("timeout", `Authentication timed out. Run ${AUTH_COMMAND} to try again.`));
        } else if (code === 0) {
          log("INFO", "Auto-auth completed successfully");
          finishChild();
        } else {
          const failures: Record<number, [AuthFailureKind, string]> = {
            2: ["busy", "Authentication already in progress in another process. Complete that attempt, then retry."],
            3: ["cooldown", `Automatic MFA is paused after an unsuccessful attempt. Run ${AUTH_COMMAND} to retry immediately.`],
            4: ["unsupported", "This identity provider cannot complete headless authentication. See the authentication logs."],
            5: ["secureStorage", "The native credential store is unavailable or locked. Unlock it and retry."],
            6: ["transport", "Brightspace authentication is temporarily unavailable because of a network or server failure. Your saved session was preserved. Try again later."],
            7: mfaPendingFailure(numberMatch),
          };
          const [kind, message] = failures[code ?? -1] ?? ["failed", `Authentication failed. Run ${AUTH_COMMAND} to try again.`];
          kill("SIGKILL");
          finishChild(new AuthProcessError(kind, message, kind === "mfaPending" ? numberMatch : undefined));
        }
      });
    });
  }
}
