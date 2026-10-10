/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * `auth --logout`: end the saved Brightspace session on this computer early.
 *
 * This is a local sign-out only. It deletes the files that let the next tool
 * call skip the browser, so that call does a full sign-in. It does not log out
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
import { SESSION_FILE, SessionStore } from "./session-store.js";
import { AUTH_COMMAND } from "../utils/commands.js";
import { resolveSessionLocation } from "../utils/config.js";

export interface ClearSessionResult {
  /** File names (not paths) that existed and were deleted, in the order they were. */
  removed: string[];
}

/** Browser state files other than the session token itself, in the order they are deleted. */
const BROWSER_STATE_FILES = [BROWSER_STATE_FILE, LEGACY_BROWSER_STATE_FILE, MICROSOFT_SESSION_FILE];

class RemoveError extends Error {
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
    if (await new SessionStore(sessionDir).remove()) removed.push(SESSION_FILE);
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
}

const KEPT = "Kept: your saved password, config.json, and any authenticator or credential-store entries.";
const MEMORY_NOTE = "A running Brightspace MCP server may still hold an access token in memory until it expires. Restart your AI client to drop it right away.";
const LOCAL_ONLY = "This only clears files on this computer. It does not sign you out of Microsoft or Brightspace on their servers.";

/**
 * The `auth --logout` command. Resolves to the process exit code: 0 when the
 * session was cleared or there was nothing to clear, 2 when a sign-in is in
 * progress (the same code `auth` uses for that), 1 for anything else.
 */
export async function runLogout(options: LogoutOptions = {}): Promise<number> {
  const print = options.print ?? ((line: string) => console.error(line));
  try {
    const sessionDir = options.sessionDir ?? resolveSessionLocation().sessionDir;
    const { removed } = await clearSavedSession(sessionDir);
    if (removed.length === 0) {
      print("No saved Brightspace session was found on this computer, so there is nothing to clear.");
    } else {
      print("Signed out of Brightspace on this computer.");
      print(`Removed: ${removed.join(", ")}`);
      print(KEPT);
      print(`The next Brightspace request, or \`${AUTH_COMMAND}\`, will do a full sign-in.`);
    }
    print(MEMORY_NOTE);
    print(LOCAL_ONLY);
    return 0;
  } catch (error) {
    if (error instanceof AuthenticationInProgressError) {
      print("Not signed out: a sign-in is in progress. Nothing was deleted.");
      print("Wait for it to finish (or cancel it), then run this command again.");
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
