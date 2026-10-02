/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../types/index.js";
import type { D2LApiClient } from "../api/client.js";
import { readMicrosoftSession } from "../auth/microsoft-session.js";
import { SessionStore } from "../auth/session-store.js";
import { getConfigStorePath } from "../utils/config-store.js";
import { GetServerInfoSchema } from "./schemas.js";
import { toolResponse } from "./tool-helpers.js";

export interface SignedInIdentity {
  uniqueName?: string;
  displayName?: string;
}

/**
 * Read whatever non-secret identity the persisted session carries, straight
 * off disk. This is local file + native keyring access only (no network),
 * and never throws: a locked keyring or a corrupted/absent session file just
 * means "don't report an identity", not a failed tool call. Identity is
 * reported regardless of whether the underlying token itself is still valid
 * — it answers "who last signed in", not "is that session still usable".
 *
 * Uses SessionStore.peek() rather than load(): load() silently upgrades a
 * legacy version-1 session file in place (a write) the first time anything
 * reads it, and this tool is called just to report status, often repeatedly
 * and never as part of establishing a session. A read-only status check
 * should not be the thing that migrates on-disk session state.
 */
async function defaultReadSignedInIdentity(sessionDir: string): Promise<SignedInIdentity | null> {
  try {
    const token = await new SessionStore(sessionDir).peek();
    if (!token || (!token.uniqueName && !token.displayName)) return null;
    return {
      ...(token.uniqueName ? { uniqueName: token.uniqueName } : {}),
      ...(token.displayName ? { displayName: token.displayName } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Register get_server_info tool.
 *
 * Answers from the startup config alone, plus a local (non-network) read of
 * the persisted session for signedInAs: no network call, so it can never
 * trigger a sign-in. hasStoredCredential reflects the keychain lookup made at
 * startup, which is the credential this process actually holds.
 * microsoftSession comes from the plain summary saved beside the browser
 * state and is omitted when there is no saved state. requests is the
 * client's own lightweight counters (apiClient.stats()) — a snapshot of
 * what has happened so far this process, not a network call of its own.
 * Nothing secret — password, username, token, cookie — is ever included.
 *
 * readSignedInIdentity is an injection seam: production leaves it to read
 * the real encrypted session store (native keyring and all), tests supply a
 * fake so they never have to touch native credential storage.
 */
export function registerGetServerInfo(
  server: McpServer,
  config: AppConfig,
  version: string,
  apiClient: Pick<D2LApiClient, "stats">,
  readSignedInIdentity: () => Promise<SignedInIdentity | null> = () =>
    defaultReadSignedInIdentity(config.sessionDir)
): void {
  server.registerTool(
    "get_server_info",
    {
      title: "Get Server Info",
      description:
        "Report which version of the Brightspace MCP server is running, the Node.js runtime, platform, config file path, session state directory, configured school URL, whether a credential is stored, the server's local timezone and UTC offset, (once a browser sign-in has been saved) what Microsoft remembered: stay-signed-in and the Don't ask again MFA checkbox, (when signed in) the account's uniqueName/displayName as signedInAs, and this process's request counters (requests: responses by status class, network errors, cache hits/misses, coalesced joins, and token refreshes). Use this for troubleshooting, when the user asks which version they have, or what timezone/account dates are being computed against. Never contacts Brightspace and never returns secrets.",
      inputSchema: GetServerInfoSchema,
    },
    async () => {
      const [microsoftSession, signedInAs] = await Promise.all([
        readMicrosoftSession(config.sessionDir),
        readSignedInIdentity(),
      ]);
      return toolResponse({
        version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        configPath: getConfigStorePath(),
        sessionStatePath: config.sessionDir,
        schoolUrl: config.baseUrl,
        hasStoredCredential: config.password !== undefined,
        localTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // Minutes the local clock is ahead of UTC (the inverse sign of
        // Date#getTimezoneOffset, which is "minutes behind UTC"). On a UTC
        // runner getTimezoneOffset() is 0, so negating it yields -0; `|| 0`
        // normalizes that back to 0 so Object.is-based equality (toBe(0) in
        // tests, and any JSON consumer that cares) sees a plain zero.
        utcOffsetMinutes: -new Date().getTimezoneOffset() || 0,
        ...(microsoftSession && { microsoftSession }),
        ...(signedInAs && { signedInAs }),
        requests: apiClient.stats(),
      });
    }
  );
}
