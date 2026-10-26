/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../types/index.js";
import type { D2LApiClient } from "../api/client.js";
import { stopAutomaticSignIn, type AuthRunner } from "../auth/auth-runner.js";
import type { TokenManager } from "../auth/token-manager.js";
import { AuthenticationInProgressError } from "../auth/auth-lock.js";
import { clearSavedSession, RemoveError } from "../auth/logout.js";
import { authLockPath } from "../auth/mfa-challenge.js";
import { log } from "../utils/logger.js";
import { SignOutSchema } from "./schemas.js";
import { withUpdateNotice } from "./tool-helpers.js";

const KEPT = "Kept (if you set them up): your saved password, your settings, and your authenticator key.";
const OTHER_APPS =
  "Other Brightspace apps open on this computer are signed out too and will sign in again from scratch on their next question. An app you opened before updating to this version may keep answering for up to an hour; quit and reopen it to sign it out right away.";
const NEXT_SIGN_IN =
  "Because your saved password (and authenticator key, if you saved one) stay on this computer, that next sign-in may just ask you to approve it, or finish on its own if you saved an authenticator key. On a shared computer, also delete the saved \"brightspace-mcp-server\" entries from your computer's password store (Keychain Access on a Mac, Credential Manager on Windows).";
const LOCAL_ONLY = "This only clears this computer. It does not sign you out of Microsoft or Brightspace on other devices.";
const IN_PROGRESS =
  "Not signed out: a sign-in that sign_out can't cancel is in progress on this computer (one started in a terminal with `auth`, for example), so nothing was deleted and it was left running. Tell the user to finish or close that sign-in, then ask again; do not call sign_out again on your own.";
const CANCELLED =
  "Cancelled the Brightspace sign-in that was waiting for approval, so the prompt or number from it no longer works.";
const NEXT_QUESTION =
  "Microsoft keeps that prompt open for up to 5 minutes after sending it and sends this account no other until then, so the next Brightspace question can take that long to show a new number to approve.";
const ALREADY_SIGNED_OUT =
  "You're already signed out of Brightspace on this computer; there was no saved session to remove.";
const NOTHING_SAVED = "There was no saved session to remove.";
const UNEXPECTED_FAILURE =
  "Could not clear the saved session because of an unexpected error. Nothing more was changed; try again, or run `npx -y brightspace-mcp-server@latest auth --logout` in a terminal to see the details.";

function text(message: string, isError = false): CallToolResult {
  const result = withUpdateNotice([{ type: "text", text: message }]);
  return isError ? { ...result, isError: true } : result;
}

/**
 * Register sign_out tool.
 *
 * The in-chat version of `auth --logout`. Both first cancel a background
 * sign-in another app on this computer started (stopAutomaticSignIn); this
 * one also cancels this server's own (AuthRunner.cancel, which answers every
 * call waiting on it), which the command has no server to do. A user who missed the
 * prompt otherwise waited out its 5-minute window for a new one. Then it
 * deletes this computer's saved
 * session for the account the server is configured with (clearSavedSession,
 * under the sign-in lock, so a running sign-in is never disturbed), then
 * empties the API client's response cache and this process's in-memory token
 * so it serves nothing from the session it just signed out of. Answers are
 * plain text, not JSON. A sign-in it cannot cancel (a person's `auth` run)
 * and an env-supplied credential are ordinary answers rather than errors, so
 * a model has no reason to retry in a loop; only a file that could not be
 * deleted is reported as a failure.
 *
 * authRunner covers the moment between this server spawning a sign-in and
 * that child taking the cross-process lock, when the lock alone still looks
 * free. It is absent when the server uses a pasted credential (no runner).
 *
 * clear and stopElsewhere are injection seams for tests.
 */
export function registerSignOut(
  server: McpServer,
  config: AppConfig,
  apiClient: Pick<D2LApiClient, "clearCache">,
  tokenManager: Pick<TokenManager, "forgetSession">,
  authRunner?: Pick<AuthRunner, "cancel">,
  clear: (sessionDir: string) => Promise<{ removed: string[] }> = clearSavedSession,
  stopElsewhere: (sessionDir: string) => Promise<boolean> = (dir) => stopAutomaticSignIn(authLockPath(dir))
): void {
  server.registerTool(
    "sign_out",
    {
      title: "Sign Out of Brightspace",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Sign out of Brightspace on this computer: cancel any sign-in still waiting for MFA approval here, then delete the saved Brightspace session, so every Brightspace app here must sign in again from scratch on its next question. Keeps the saved password, settings, and authenticator key. Does not sign out of Microsoft or Brightspace on other devices. Cancelling a waiting sign-in doesn't get a new prompt sooner: Microsoft sends no other prompt to the account until the one already sent expires, up to 5 minutes after it was sent. Call this ONLY when the user explicitly asks to sign out or log out of Brightspace (a shared computer, handing the machine on). Never call it on your own to fix an error, to get a new prompt, or as part of answering another question.",
      inputSchema: SignOutSchema,
    },
    async () => {
      if (config.envAccessToken || config.envSessionCookie) {
        return text(
          "Nothing was signed out. This server uses a credential from its configuration (D2L_ACCESS_TOKEN or D2L_SESSION_COOKIE, set in your AI app's client configuration or a .env file), and sign_out cannot remove that. To stop using it, remove that setting and restart the app."
        );
      }
      const dropInMemory = () => {
        apiClient.clearCache();
        tokenManager.forgetSession();
      };
      try {
        // This server's own sign-in first: stopping it also answers its waiting calls.
        let cancelled = (await authRunner?.cancel()) ?? false;
        if (await stopElsewhere(config.sessionDir)) cancelled = true;
        const { removed } = await clear(config.sessionDir);
        dropInMemory();
        if (removed.length === 0) {
          return text(cancelled ? [CANCELLED, NOTHING_SAVED, NEXT_QUESTION].join("\n") : ALREADY_SIGNED_OUT);
        }
        return text(
          [
            ...(cancelled ? [CANCELLED] : []),
            "Signed out of Brightspace on this computer.",
            `Removed: ${removed.join(", ")}`,
            KEPT,
            OTHER_APPS,
            ...(cancelled ? [NEXT_QUESTION] : []),
            NEXT_SIGN_IN,
            LOCAL_ONLY,
          ].join("\n")
        );
      } catch (error) {
        if (error instanceof AuthenticationInProgressError) return text(IN_PROGRESS);
        dropInMemory();
        if (error instanceof RemoveError) {
          log("ERROR", "sign_out could not remove a session file", error);
          return text(
            `Sign-out is incomplete: ${error.file} could not be deleted, so part of the saved session is still on this computer. Close anything that may be using that file, then ask to sign out again to finish.`,
            true
          );
        }
        log("ERROR", "sign_out failed", error);
        return text(UNEXPECTED_FAILURE, true);
      }
    }
  );
}
