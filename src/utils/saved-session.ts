/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Read-only access to the saved sign-in, shared by `doctor` and
 * `setup --prepare`. Lives apart from doctor.ts because importing that module
 * runs the doctor command.
 */

import * as path from "node:path";
import * as os from "node:os";
import type { ConfigStoreData } from "./config-store.js";
import { accountSessionDirectory, expandTilde } from "./config.js";
import { TokenManager, type TokenManagerOptions } from "../auth/token-manager.js";
import { SessionStore } from "../auth/session-store.js";
import type { TokenData } from "../types/index.js";

/**
 * doctor only ever reads a saved session — it must never write session.json,
 * trash it, or take the write lock a v1-record migration uses (that lock can
 * also throw AuthenticationInProgressError while a real sign-in holds it).
 * SessionStore.peek() is the read-only sibling of load() that does none of
 * that, so every write-shaped method here is a no-op and load() delegates to
 * peek() instead of the real load(). Exported for tests, which pass a fake
 * in place of a real SessionStore to prove the no-op wiring.
 */
export function readOnlySessionStore(store: Pick<SessionStore, "peek">): NonNullable<TokenManagerOptions["sessionStore"]> {
  return {
    load: () => store.peek(),
    save: async () => {},
    clear: async () => {},
    saveIfCurrent: async () => true,
    clearIfCurrent: async () => true,
  };
}

/** A TokenManager that can mint from a saved cookie but can never write, clear, or migrate session.json. */
export function readOnlyTokenManager(baseUrl: string, sessionDir: string, envAccessToken?: string, envSessionCookie?: string): TokenManager {
  return new TokenManager({
    baseUrl,
    envAccessToken,
    envSessionCookie,
    sessionStore: readOnlySessionStore(new SessionStore(sessionDir)),
  });
}

/** The saved sign-in's token, read-only: never a browser and never a write. Shared with `setup --prepare`. */
export function readSavedSessionToken(
  baseUrl: string,
  sessionDir: string,
  envAccessToken?: string,
  envSessionCookie?: string,
): Promise<TokenData | null> {
  return readOnlyTokenManager(baseUrl, sessionDir, envAccessToken, envSessionCookie).getToken();
}

/** Where the saved session for this account lives, honouring D2L_SESSION_DIR and config.json's sessionDir. */
export function sessionDirFor(
  env: NodeJS.ProcessEnv,
  store: ConfigStoreData | null,
  baseUrl: string,
  username: string | undefined,
): string {
  const sessionRoot = env.D2L_SESSION_DIR
    ? expandTilde(env.D2L_SESSION_DIR)
    : store?.sessionDir
      ? expandTilde(store.sessionDir)
      : path.join(os.homedir(), ".d2l-session");
  return accountSessionDirectory(sessionRoot, baseUrl, username);
}

/** True for the Node versions this package supports (22 and newer). */
export function nodeVersionSupported(version: string): boolean {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return Number.isFinite(major) && major >= 22;
}
