/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * `auth --logout`: end the saved Brightspace session on this computer early.
 *
 * This is a local sign-out only. It first stops a background sign-in an AI
 * app started (as sign_out does), then deletes the files that let the next
 * tool call skip the browser, so that call does a full sign-in. It does not log out
 * of Microsoft or D2L on their servers, and it leaves the saved password,
 * config.json, and every credential-store entry (including the session
 * encryption key, which the next sign-in reuses) exactly as they were.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireProcessLock, AuthenticationInProgressError } from "./auth-lock.js";
import { BROWSER_STATE_FILE, LEGACY_BROWSER_STATE_FILE } from "./browser-state-store.js";
import { MICROSOFT_SESSION_FILE } from "./microsoft-session.js";
import { authLockPath } from "./mfa-challenge.js";
import { stopAutomaticSignIn } from "./auth-runner.js";
import { SESSION_FILE, SessionStore } from "./session-store.js";
import { AUTH_COMMAND } from "../utils/commands.js";
import { resolveSessionLocation } from "../utils/config.js";

export interface ClearSessionResult {
  /** File names (not paths) that existed and were deleted, in the order they were. */
  removed: string[];
}

/** Browser state files other than the session token itself, in the order they are deleted. */
const BROWSER_STATE_FILES = [BROWSER_STATE_FILE, LEGACY_BROWSER_STATE_FILE, MICROSOFT_SESSION_FILE];

export class RemoveError extends Error {
  constructor(readonly file: string, cause: unknown) {
    super(`Could not remove ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "RemoveError";
  }
}

async function removeIfPresent(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new RemoveError(path.basename(file), error);
  }
}

/** SessionStore.remove() throws SessionStoreError; report it like every other file that would not delete. */
async function removeSessionFile(sessionDir: string): Promise<boolean> {
  try {
    return await new SessionStore(sessionDir).remove();
  } catch (error) {
    // A session write that holds its lock too long is still "in progress", not a file that won't delete.
    if (error instanceof AuthenticationInProgressError) throw error;
    throw new RemoveError(SESSION_FILE, error);
  }
}

/**
 * Delete the saved session files in one account's session directory.
 *
 * `sessionDir` is the resolved directory: `accounts/<hash>/` when a username
 * is configured, the session root otherwise. Siblings, other accounts, and
 * the pre-account files above `accounts/` are never this account's session
 * and are not touched. The plaintext `storage-state.json` a version 1 install
 * left behind is included because loading browser state would re-adopt it.
 *
 * Holds the sign-in lock for the duration, in a mode that neither takes over
 * a live sign-in nor can be taken over, and throws AuthenticationInProgressError
 * without deleting anything if one is running. It also waits out any session
 * write already in flight rather than racing it.
 */
export async function clearSavedSession(sessionDir: string): Promise<ClearSessionResult> {
  // Taking the lock creates its parent directory; there is nothing to clear
  // (and nothing to create) when there is no directory at all.
  try {
    await fs.access(sessionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: [] };
    throw error;
  }

  const release = await acquireProcessLock(authLockPath(sessionDir), { mode: "exclusive" });
  try {
    const removed: string[] = [];
    if (await removeSessionFile(sessionDir)) removed.push(SESSION_FILE);
    for (const name of BROWSER_STATE_FILES) {
      if (await removeIfPresent(path.join(sessionDir, name))) removed.push(name);
    }
    return { removed };
  } finally {
    await release();
  }
}

export interface LogoutOptions {
  /** Session directory to clear. Defaults to the one the current configuration signs in with. */
  sessionDir?: string;
  /** Where the report goes. Defaults to stderr, like the rest of the `auth` command. */
  print?: (line: string) => void;
  /**
   * Stop a background sign-in an AI app started for this session, resolving
   * true once it has exited. Defaults to stopAutomaticSignIn, which never
   * stops a person's `auth` run and does nothing on Windows.
   */
  stopBackground?: (sessionDir: string) => Promise<boolean>;
}

const KEPT = "Kept: your saved password, config.json, and any authenticator or credential-store entries.";
const MEMORY_NOTE =
  "Other Brightspace apps open on this computer sign out on their next request. One you opened before updating may keep answering for up to an hour; quit and reopen it to sign it out right away.";
const LOCAL_ONLY = "This only clears files on this computer. It does not sign you out of Microsoft or Brightspace on their servers.";
const CANCELLED =
  "Cancelled the Brightspace sign-in that was waiting for approval, so the prompt or number from it no longer works.";
const NEXT_PROMPT =
  "Microsoft keeps that prompt open for up to 5 minutes after sending it and sends this account no other until then, so the next sign-in can take that long to show a new number to approve.";

/**
 * The `auth --logout` command. Resolves to the process exit code: 0 when the
 * session was cleared or there was nothing to clear, 2 when a sign-in or
 * sign-out it can't stop holds the lock (the same code `auth` uses for that),
 * 1 for anything else. A background sign-in an AI app started is stopped
 * first; a person's `auth` run is never stopped.
 */
export async function runLogout(options: LogoutOptions = {}): Promise<number> {
  const print = options.print ?? ((line: string) => console.error(line));
  try {
    const sessionDir = options.sessionDir ?? resolveSessionLocation().sessionDir;
    // A sign-in an AI app started in the background holds the lock, and a
    // terminal has no other way to stop it, so stop it as sign_out does.
    const stopBackground = options.stopBackground ?? ((dir: string) => stopAutomaticSignIn(authLockPath(dir)));
    const cancelled = await stopBackground(sessionDir);
    if (cancelled) print(CANCELLED);
    let removed: string[];
    try {
      ({ removed } = await clearSavedSession(sessionDir));
    } catch (error) {
      // The lock was taken again between stopping one sign-in and clearing:
      // most likely the AI app's next question started a new one.
      if (cancelled && error instanceof AuthenticationInProgressError) {
        print("Not signed out: a new sign-in started before the session could be cleared, so nothing was deleted. Run this command again.");
        return 2;
      }
      throw error;
    }
    if (removed.length === 0) {
      print("No saved Brightspace session was found on this computer, so there is nothing to clear.");
    } else {
      print("Signed out of Brightspace on this computer.");
      print(`Removed: ${removed.join(", ")}`);
      print(KEPT);
      print(`The next Brightspace request, or \`${AUTH_COMMAND}\`, will do a full sign-in.`);
    }
    print(MEMORY_NOTE);
    if (cancelled) print(NEXT_PROMPT);
    print(LOCAL_ONLY);
    return 0;
  } catch (error) {
    if (error instanceof AuthenticationInProgressError) {
      print("Not signed out: a sign-in or sign-out this command can't stop is in progress, so nothing was deleted.");
      print("If it is an `auth` run in another terminal, finish or close it there. On Windows, a sign-in an AI app started can't be stopped from here: wait for it to finish (up to 5 minutes). Then run this command again.");
      return 2;
    }
    if (error instanceof RemoveError) {
      print(`Sign-out is incomplete. ${error.message}`);
      print("Close anything that may be using that file, then run this command again to finish.");
      return 1;
    }
    print(`Could not clear the saved session: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
