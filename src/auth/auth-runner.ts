/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { log } from "../utils/logger.js";
import { AuthError } from "../utils/errors.js";
import { AUTH_COMMAND } from "../utils/commands.js";
import { devActivity } from "../utils/dev-activity.js";
import { parsePhaseMarker } from "./auth-phases.js";
import { AUTOMATIC_PENDING_MARKER, RELAYED_CHALLENGE_MARKER, authLockPath, challengeRelayedAt, relayChallenge } from "./mfa-challenge.js";

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
 * How long a caller keeps waiting for the background sign-in once the
 * challenge is known: long enough to find a phone and approve. Applies both
 * to a caller told the challenge mid-call (see run()'s onChallenge) and to a
 * retry that joins the background child after an early answer. The retry
 * used to wait only 5 s, so on clients that send no progress token (Claude
 * Desktop) every retry re-answered "enter the number" and the model asked
 * the user to confirm by hand instead of the server polling for the approval.
 */
const MFA_POLL_MS = 45000;

/**
 * The latest any caller is answered, counted from when it called run().
 * Browser launch and the SSO pages can take half a minute before the
 * challenge even appears, so the poll is cut short to fit this budget, and a
 * sign-in that has not reached MFA by then answers "still signing in" while
 * it keeps running. It stays under the 60-second request timeout MCP clients
 * commonly apply, so a client that never shows the mid-call notice still gets
 * the number in the answer.
 */
const CALL_BUDGET_MS = 55000;

/**
 * How long a background sign-in past its MFA challenge keeps running once
 * nobody is waiting on it (issue #199). The answer carrying the number can be
 * cancelled, or held in a parallel batch the user never sees; the child then
 * kept its browser and the cross-process lock for the whole 5-minute MFA
 * window, and every server sharing the session was stuck behind it. A user
 * who did see the number calls again, which polls for another MFA_POLL_MS, so
 * the same span without any caller (in this process, or relaying the number
 * from another one) means nobody is approving.
 */
const ABANDON_MS = MFA_POLL_MS;

/**
 * How often a caller waiting on ANOTHER process's sign-in looks at the lock.
 * Each look also touches the challenge file (relayChallenge), which tells that
 * process's abandonment watcher someone still wants its sign-in. It has to
 * stay well under ABANDON_MS.
 */
const RELAY_POLL_MS = 1000;

/**
 * How long a relayed challenge stays "already told to a caller" for the rule
 * that only a RETRY waits on another process's sign-in. The MFA window is five
 * minutes, so a number reported longer ago than that belongs to a sign-in that
 * is over; the same digits showing up again are a new challenge.
 */
const RELAY_TOLD_MS = 5 * 60 * 1000;

/**
 * Calls arriving within this long of a batch's first call count as that batch
 * (issue #212). A client running tool calls in parallel sends them within
 * milliseconds; a model retrying after reading an answer takes a whole round
 * trip, and each call is held up to CALL_BUDGET_MS anyway, so a retry always
 * lands in a fresh batch and gets the number again.
 */
const WAVE_MS = 5000;

/**
 * Milliseconds until a background sign-in counts as abandoned; zero or less
 * means it already is. A caller still waiting keeps it alive outright;
 * otherwise the clock runs from the latest moment anyone attended to it.
 */
function abandonDelayMs(waiting: number, attendedAt: number, now: number): number {
  return waiting > 0 ? ABANDON_MS : attendedAt + ABANDON_MS - now;
}

/** How long to poll after a challenge seen elapsedMs into the call. */
function pollWindowMs(elapsedMs: number): number {
  return Math.min(MFA_POLL_MS, CALL_BUDGET_MS - elapsedMs);
}

/**
 * The only two lines auth-cli.ts is allowed to hand back as structured data
 * for a tool response; parsePhaseMarker adds stage timings for the dev
 * activity log only. Deliberately strict (whole line, 1-3 digits or the
 * literal word) so this can never become a channel for arbitrary
 * child-process text to reach a tool response — anything that doesn't match
 * exactly is just another log line.
 */
const MFA_NUMBER_MARKER = /^MFA_NUMBER:(\d{1,3})$/;
const MFA_PENDING_MARKER = /^MFA_PENDING$/;

/** The mfaPending kind and message, with or without number-match digits. */
function mfaPendingFailure(numberMatch: string | undefined): [AuthFailureKind, string] {
  return numberMatch
    ? ["mfaPending", `Open Microsoft Authenticator and enter ${numberMatch} within 5 minutes, then try again.`]
    : ["mfaPending", "An MFA approval was not completed in time. Try again."];
}

/**
 * The child is answering its own verification code from the saved
 * authenticator enrollment. Deliberately NOT an mfaPending: there is nothing
 * on anyone's phone to approve, so a caller told "approve the request" would
 * send the user looking for a prompt that will never arrive.
 */
const automaticPendingFailure = (relayed = false): AuthProcessError => new AuthProcessError(
  "automaticPending",
  "Sign-in is entering its own verification code in the background. Try again.",
  undefined,
  false,
  relayed,
);

export type AuthFailureKind = "busy" | "cooldown" | "unsupported" | "secureStorage" | "transport" | "timeout" | "failed" | "mfaPending" | "automaticPending" | "inProgress";

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
    /**
     * Another call in the same parallel batch already carried this exact
     * challenge to the user (issue #212), so this one should answer briefly
     * instead of repeating the number and the instructions.
     */
    public readonly duplicate: boolean = false,
    /**
     * The challenge belongs to a sign-in in ANOTHER server process that holds
     * the cross-process lock; this process's child only relayed it and
     * exited. There is no local child to join, so a caller that wants to
     * keep waiting watches the lock instead (see AuthRunner.attendRelay).
     */
    public readonly relayed: boolean = false,
  ) {
    super(message);
    this.name = "AuthProcessError";
  }
}

export interface AuthRunnerOptions {
  timeoutMs?: number;
  onProgress?: (line: string) => void;
  /**
   * The account's session directory, shared with other server processes. A
   * caller in another process relaying this sign-in's number marks the
   * challenge there, which keeps the sign-in from being abandoned.
   */
  sessionDir?: string;
}

/**
 * Settle with work's outcome, or with inProgress once CALL_BUDGET_MS has
 * passed since startedAt. Only the caller stops waiting: work carries on.
 */
function withinCallBudget(work: Promise<boolean>, startedAt: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const budgetTimer = setTimeout(() => {
      reject(new AuthProcessError("inProgress", "Sign-in is still running in the background. Try again."));
    }, Math.max(0, CALL_BUDGET_MS - (Date.now() - startedAt)));
    budgetTimer.unref?.();
    work.then(
      (value) => { clearTimeout(budgetTimer); resolve(value); },
      (error) => { clearTimeout(budgetTimer); reject(error); },
    );
  });
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
 * so both processes read the same account configuration and .env file. It
 * runs headless unless D2L_HEADLESS is set explicitly.
 *
 * run() settles as soon as the child reports an MFA challenge (with or
 * without a number to display) rather than waiting for the child to exit —
 * a tool call must not block for the whole approval window. The child keeps
 * running in the background; a later run() call joins that background child
 * instead of spawning a second one.
 */
/**
 * The first call in a batch to report a challenge carries it in full; every
 * later call reporting the SAME challenge answers briefly (issue #212).
 *
 * Only calls that joined BEFORE the first report are siblings; joinWave opens
 * a fresh batch for anything after it (see the comment in the body).
 *
 * First-reporter-wins, decided synchronously, rather than "wait for the
 * owner": a caller holding a progress token keeps polling up to 45 s after
 * the challenge, and making the others wait on it would hold them that long.
 * A refreshed number is a different challenge and is reported in full again,
 * so the digits always reach at least one response. Only the report is
 * deduplicated: the challenge relay between processes (mfa-challenge.ts) and
 * its abandonment signal are untouched.
 */
interface Wave { openedAt: number; delivered: Set<string>; closed: boolean }

function dedupeChallenge(error: unknown, wave: Wave): unknown {
  // automaticPending repeats across a batch exactly as mfaPending did (#212),
  // just without digits: one sign-in, N copies of the same paragraph.
  if (!(error instanceof AuthProcessError) || error.duplicate) return error;
  if (error.kind !== "mfaPending" && error.kind !== "automaticPending") return error;
  const key = `${error.kind}:${error.numberMatch ?? ""}`;
  if (!wave.delivered.has(key)) {
    wave.delivered.add(key);
    // Once a challenge has gone back to the user, the batch is over: every
    // call already in it is a sibling, but a call arriving from now on is a
    // RETRY -- quite possibly because the client hid this very answer -- and
    // must get the digits in full. This is what keeps #201's guarantee.
    wave.closed = true;
    return error;
  }
  return new AuthProcessError(error.kind, error.message, error.numberMatch, true, error.relayed);
}

/** Identifies a challenge for "was this already reported to a caller". */
const relayKey = (kind: string, numberMatch: string | undefined): string => `${kind}:${numberMatch ?? ""}`;

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
  private pendingChallenge: { kind: "mfaPending" | "automaticPending"; numberMatch?: string } | null = null;
  /** Resolves on the next marker from the current child; null between children. */
  private challengeSignal: Promise<void> | null = null;
  /** Callers inside run() right now. */
  private waiting = 0;
  /** When the last caller left run(). */
  private lastAttendedAt = 0;
  /**
   * The current parallel batch and the challenges already handed to one of
   * its calls (issue #212). The sign-in itself is shared through inFlight and
   * childDone; this only stops every call in the batch repeating the number.
   */
  private wave: Wave | null = null;
  /**
   * Challenges another process's sign-in is showing that a caller here was
   * already told, by relayKey, and when. A retry of one of these waits on
   * that sign-in instead of repeating the answer (see attendRelay).
   */
  private readonly relayTold = new Map<string, number>();
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly onProgress?: (line: string) => void;
  private readonly sessionDir?: string;

  constructor(options: AuthRunnerOptions = {}) {
    // Resolve paths relative to this file's compiled location (build/auth/auth-runner.js)
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    this.scriptPath = path.resolve(thisDir, "..", "auth-cli.js");
    this.timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS;
    this.onProgress = options.onProgress;
    this.sessionDir = options.sessionDir;
  }

  /**
   * Authenticate, joining the login this process already started if there is
   * one. Returns true on success and throws a useful error on failure.
   *
   * Without onChallenge, a NEW sign-in answers the caller at once when an MFA
   * challenge appears (an mfaPending error carrying the number to enter: the
   * user cannot see it any other way), and the next call joins the background
   * sign-in and polls it for up to MFA_POLL_MS, never past CALL_BUDGET_MS from
   * that call. With onChallenge, the caller is handed the challenge mid-call
   * and the first call itself keeps waiting the same way. Either way an
   * approval within the window completes the caller's original request; past
   * it, the caller gets the same mfaPending answer again and is expected to
   * call once more. No caller waits past CALL_BUDGET_MS: a sign-in still
   * short of its challenge by then answers inProgress and keeps running for
   * the next call to join.
   */
  async run(onChallenge?: (numberMatch: string | undefined) => void): Promise<boolean> {
    // Synchronous, before any await: calls in one tick cannot split a batch.
    const wave = this.joinWave();
    // Also synchronous: what was already told BEFORE this call, so siblings in
    // one parallel batch are not each other's "retry" (they answer briefly via
    // dedupeChallenge instead of waiting).
    const toldBefore = this.relayChallengesTold();
    this.waiting += 1;
    try {
      return await this.attend(onChallenge, toldBefore);
    } catch (error) {
      this.noteRelayReported(error);
      throw dedupeChallenge(error, wave);
    } finally {
      this.waiting -= 1;
      this.lastAttendedAt = Date.now();
    }
  }

  private relayChallengesTold(): Set<string> {
    const now = Date.now();
    const told = new Set<string>();
    for (const [key, at] of this.relayTold) {
      if (now - at > RELAY_TOLD_MS) this.relayTold.delete(key);
      else told.add(key);
    }
    return told;
  }

  /** A relayed challenge that went back to a caller counts as told. */
  private noteRelayReported(error: unknown): void {
    if (!(error instanceof AuthProcessError) || !error.relayed) return;
    if (error.kind !== "mfaPending" && error.kind !== "automaticPending") return;
    this.relayTold.set(relayKey(error.kind, error.numberMatch), Date.now());
  }

  private joinWave(): Wave {
    const now = Date.now();
    if (!this.wave || this.wave.closed || now - this.wave.openedAt > WAVE_MS) {
      this.wave = { openedAt: now, delivered: new Set(), closed: false };
    }
    return this.wave;
  }

  private async attend(
    onChallenge: ((numberMatch: string | undefined) => void) | undefined,
    toldBefore: ReadonlySet<string>,
  ): Promise<boolean> {
    const startedAt = Date.now();
    try {
      return await withinCallBudget(this.runOnce(startedAt), startedAt);
    } catch (error) {
      if (this.sessionDir && error instanceof AuthProcessError && error.relayed) {
        return this.attendRelay(error, startedAt, onChallenge, toldBefore);
      }
      const childDone = this.childDone;
      if (!childDone || !(error instanceof AuthProcessError)) throw error;
      // An mfaPending is only worth waiting on when the caller can relay the
      // number mid-call. An automaticPending needs no relay at all — nobody is
      // being asked for anything — so keep waiting on it either way.
      const joinable = error.kind === "automaticPending" || (Boolean(onChallenge) && error.kind === "mfaPending");
      if (!joinable) throw error;
      const windowMs = pollWindowMs(Date.now() - startedAt);
      if (windowMs <= 0) throw error;
      if (error.kind === "mfaPending") {
        try { onChallenge?.(error.numberMatch); } catch { /* Announcing must not interrupt authentication. */ }
      }
      return this.awaitBackgroundChild(childDone, windowMs);
    }
  }

  /**
   * The caller's sign-in found ANOTHER process's sign-in holding the lock,
   * and that process is showing a challenge. The local child has already
   * exited, so unlike awaitBackgroundChild there is nothing here to join:
   * the lock is the only thing to watch.
   *
   * The first answer is still immediate for a caller that cannot be told
   * mid-call, because the number is what the user needs and every second
   * before it is a second the other sign-in's window runs down. A RETRY of the
   * same challenge (already reported to a caller in this process) waits, like
   * a retry joining a local child, instead of re-answering at once: answering
   * a loop of retries in milliseconds made a model conclude the approval
   * window had closed while the other sign-in was still waiting. A caller
   * that can be told mid-call is told and waits at once, and an owner
   * answering its own code has nothing to relay, so every caller waits.
   */
  private attendRelay(
    error: AuthProcessError,
    startedAt: number,
    onChallenge: ((numberMatch: string | undefined) => void) | undefined,
    toldBefore: ReadonlySet<string>,
  ): Promise<boolean> {
    const retry = toldBefore.has(relayKey(error.kind, error.numberMatch));
    const waits = error.kind === "automaticPending"
      || (error.kind === "mfaPending" && (Boolean(onChallenge) || retry));
    if (!waits) throw error;
    const windowMs = pollWindowMs(Date.now() - startedAt);
    if (windowMs <= 0) throw error;
    if (error.kind === "mfaPending" && onChallenge) {
      try { onChallenge(error.numberMatch); } catch { /* Announcing must not interrupt authentication. */ }
      this.noteRelayReported(error);
    }
    return this.awaitRelayedOwner(error, windowMs);
  }

  /**
   * Wait up to windowMs for another process's sign-in to finish, by watching
   * its lock directory about once a second.
   *
   * Each look also relays the challenge, which touches its file: that is the
   * signal the owner's abandonment watcher (ABANDON_MS) reads as "someone is
   * still waiting", so the owner is not killed under a user who is approving.
   * The lock disappearing means the owner is done, and the caller resolves
   * true so the client re-reads the session. If the owner FAILED there is no
   * session, and the client's own "session expired" 401 follows; the next call
   * starts a fresh sign-in and gets the owner's cooldown or error as usual.
   * Spawning another sign-in here instead would risk a second MFA prompt for
   * a login that just succeeded. When the window ends with the lock still
   * held, the caller gets the latest challenge the owner showed.
   */
  private async awaitRelayedOwner(error: AuthProcessError, windowMs: number): Promise<boolean> {
    const lockPath = authLockPath(this.sessionDir as string);
    const deadline = Date.now() + windowMs;
    let latest: { automatic: boolean; numberMatch?: string } = {
      automatic: error.kind === "automaticPending",
      numberMatch: error.numberMatch,
    };
    for (;;) {
      const held = await fs.access(lockPath).then(() => true, () => false);
      if (!held) {
        this.relayTold.clear();
        return true;
      }
      const relayed = await relayChallenge(lockPath);
      if (relayed) {
        latest = relayed.kind === "automatic"
          ? { automatic: true }
          : { automatic: false, numberMatch: relayed.numberMatch ?? (latest.automatic ? undefined : latest.numberMatch) };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(RELAY_POLL_MS, remaining));
        timer.unref?.();
      });
    }
    if (latest.automatic) throw automaticPendingFailure(true);
    throw new AuthProcessError(...mfaPendingFailure(latest.numberMatch), latest.numberMatch, false, true);
  }

  private runOnce(startedAt: number): Promise<boolean> {
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
      return this.joinBackgroundChild(this.childDone, startedAt);
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
   * blocks for whatever is left of the 5-minute approval window, past the
   * client's request timeout.
   *
   * If no challenge has been reported yet (the child hasn't reached MFA),
   * wait for one — or for the child to finish on its own. Once a challenge
   * is known, poll the child for the rest of this call's budget: the user
   * read the number from the previous answer and is approving right now, so
   * this is the call that should carry the result. A still-unapproved
   * sign-in re-answers with the latest challenge and the caller tries again.
   */
  private async joinBackgroundChild(childDone: Promise<boolean>, startedAt: number): Promise<boolean> {
    if (!this.pendingChallenge && this.challengeSignal) {
      await Promise.race([childDone.catch(() => {}), this.challengeSignal]);
    }

    if (!this.pendingChallenge) return childDone;
    return this.awaitBackgroundChild(childDone, Math.max(0, pollWindowMs(Date.now() - startedAt)));
  }

  /**
   * Race a background child already past its MFA challenge against a wait
   * of graceMs. The child's own outcome wins if it lands in time; otherwise
   * the caller is re-answered with the latest challenge the child reported.
   */
  private awaitBackgroundChild(childDone: Promise<boolean>, graceMs: number): Promise<boolean> {
    const challenge = this.pendingChallenge;
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const graceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const pending = this.pendingChallenge ?? challenge;
        if (pending?.kind === "automaticPending") {
          reject(automaticPendingFailure());
          return;
        }
        const numberMatch = this.pendingChallenge?.numberMatch ?? challenge?.numberMatch;
        reject(new AuthProcessError(...mfaPendingFailure(numberMatch), numberMatch));
      }, graceMs);
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
    const started = Date.now();
    devActivity("recovery_started");
    log("INFO", "Auto-launching brightspace-auth...");

    return await new Promise<boolean>((resolve, reject) => {
      const child = spawn(
        process.execPath, // use the same Node binary
        [this.scriptPath, "--automatic"],
        {
          cwd: process.cwd(),
          // Background recovery never opens a browser over the user's work
          // unless D2L_HEADLESS explicitly asks for one; the saved
          // visible-browser preference applies to manual sign-in only.
          env: { D2L_HEADLESS: "true", ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
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
      let challengeSeen = false;
      /** The child said the challenge it is about to print is another process's. */
      let relayed = false;
      /** The child reported it is answering its own code (see the marker below). */
      let automaticSeen = false;
      /** watchAttention is armed once per child; a second timer could kill a live sign-in. */
      let attentionWatched = false;
      let abandonTimer: ReturnType<typeof setTimeout> | undefined;
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
          this.wave = null;
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
      // Once the child is past its challenge, stop it when nobody is waiting
      // on it any more (see ABANDON_MS). SIGKILL rather than SIGTERM: a
      // graceful stop runs the MFA loop's failure path, which records the
      // cooldown, and the user never had a chance to answer. The dead owner
      // leaves a stale lock the next sign-in reclaims.
      const watchAttention = () => {
        if (childFinished) return;
        const relayedAt = this.sessionDir ? challengeRelayedAt(authLockPath(this.sessionDir)) ?? 0 : 0;
        const delayMs = abandonDelayMs(this.waiting, Math.max(this.lastAttendedAt, relayedAt), Date.now());
        if (delayMs > 0) {
          abandonTimer = setTimeout(watchAttention, delayMs);
          abandonTimer.unref?.();
          return;
        }
        log("WARN", "Stopping a background sign-in nobody is waiting on; its MFA prompt went unanswered");
        kill("SIGKILL");
        finishChild(new AuthProcessError("timeout", `The sign-in was stopped because nobody approved its MFA prompt. Try again, or run ${AUTH_COMMAND}.`));
      };

      const startWatching = () => {
        if (attentionWatched) return;
        attentionWatched = true;
        watchAttention();
      };

      const publishChallenge = (matched: string | undefined) => {
        challengeSeen = true;
        // An automatic sign-in that later shows a real approval challenge (it
        // fell back, or Entra changed its mind) must be upgraded, so a joiner
        // is told the number instead of "still working".
        const firstChallenge = this.pendingChallenge === null || this.pendingChallenge.kind === "automaticPending";
        startWatching();
        if (firstChallenge) devActivity("mfa_observed", { elapsedMs: Date.now() - started });
        if (firstChallenge || matched) {
          this.pendingChallenge = { kind: "mfaPending", numberMatch: matched ?? this.pendingChallenge?.numberMatch };
        }
        if (firstChallenge) resolveChallengeSignal();
        if (!callerSettled) {
          settleCaller(new AuthProcessError(...mfaPendingFailure(this.pendingChallenge?.numberMatch), this.pendingChallenge?.numberMatch, false, relayed));
        }
      };

      /**
       * The child is typing its own verification code. Watched for abandonment
       * exactly like an approval challenge: a sign-in nobody is waiting on
       * still holds the cross-process lock, and every caller is told to retry
       * right away, which keeps it alive (see ABANDON_MS).
       */
      const publishAutomaticProgress = () => {
        automaticSeen = true;
        if (this.pendingChallenge) return;
        this.pendingChallenge = { kind: "automaticPending" };
        startWatching();
        resolveChallengeSignal();
        settleCaller(automaticPendingFailure(relayed));
      };

      // Runs once the child is actually done. Settles the caller too, if an
      // early answer had not already done so; otherwise this is just the
      // background sign-in finishing, which only childDone's joiner sees.
      const finishChild = (error?: AuthProcessError) => {
        if (childFinished) return;
        childFinished = true;
        devActivity("recovery_finished", { outcome: error ? "error" : "success", reason: error?.kind, elapsedMs: Date.now() - started });
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (abandonTimer) clearTimeout(abandonTimer);
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
        const phaseMarker = parsePhaseMarker(line);
        if (phaseMarker) {
          devActivity("auth_phase", phaseMarker);
        } else if (numberMarker) {
          numberMatch = numberMarker[1];
          publishChallenge(numberMatch);
        } else if (MFA_PENDING_MARKER.test(line)) {
          publishChallenge(undefined);
        } else if (line === AUTOMATIC_PENDING_MARKER) {
          publishAutomaticProgress();
        } else if (line === RELAYED_CHALLENGE_MARKER) {
          // Recorded as the line is read, so it is set before the challenge
          // marker that follows it settles the caller.
          relayed = true;
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
            2: ["busy", `Authentication already in progress in another process. Complete that attempt, then retry, or run \`${AUTH_COMMAND}\` in a terminal to take over that background attempt.`],
            3: ["cooldown", `Automatic MFA is paused after an unsuccessful attempt. Run ${AUTH_COMMAND} to retry immediately.`],
            4: ["unsupported", "This identity provider cannot complete headless authentication. See the authentication logs."],
            5: ["secureStorage", "The native credential store is unavailable or locked. Unlock it and retry."],
            6: ["transport", "Brightspace authentication is temporarily unavailable because of a network or server failure. Your saved session was preserved. Try again later."],
            7: mfaPendingFailure(numberMatch),
          };
          // Busy, but the owning sign-in's challenge came through: the caller
          // was told what to approve, so answer with that, not "busy".
          if (code === 2 && challengeSeen) failures[2] = mfaPendingFailure(numberMatch);
          // Busy because another process is signing in automatically: there is
          // nothing to approve, so say that rather than "busy".
          else if (code === 2 && automaticSeen) failures[2] = ["automaticPending", automaticPendingFailure().message];
          const [kind, message] = failures[code ?? -1] ?? ["failed", `Authentication failed. Run ${AUTH_COMMAND} to try again.`];
          kill("SIGKILL");
          const challenged = kind === "mfaPending" || kind === "automaticPending";
          finishChild(new AuthProcessError(kind, message, kind === "mfaPending" ? numberMatch : undefined, false, relayed && challenged));
        }
      });
    });
  }
}
