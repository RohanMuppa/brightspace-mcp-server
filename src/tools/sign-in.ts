/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../types/index.js";
import type { TokenManager } from "../auth/token-manager.js";
import { AuthProcessError, type AuthFailureKind, type AuthRunner } from "../auth/auth-runner.js";
import { log } from "../utils/logger.js";
import { createSSOFlow } from "../auth/sso-flow.js";
import { SignInSchema } from "./schemas.js";
import { authPendingNotice, sanitizeError, textResponse as text } from "./tool-helpers.js";
import { AUTH_COMMAND, SETUP_COMMAND } from "../utils/commands.js";

const ALREADY =
  "Already signed in to Brightspace on this computer; the saved session is still valid. Nothing was changed. Go ahead and call the tool you actually need.";
const ENV_CREDENTIAL =
  "Nothing to do. This server authenticates with a credential from its configuration (D2L_ACCESS_TOKEN or D2L_SESSION_COOKIE), not with a sign-in it can start. If Brightspace is rejecting it, the user has to paste a fresh one into their AI app's configuration or .env file and restart the app.";
const NO_RUNNER =
  `This server cannot start a sign-in itself. Tell the user to run \`${AUTH_COMMAND}\` in a terminal, prefixed with D2L_HEADLESS=false if they need to see the sign-in page and finish it by hand.`;
const SUCCESS =
  "Signed in to Brightspace. The session is saved on this computer, so other Brightspace apps here can use it too.";
/** What an open window means for the caller: this one waits on a person, not on a retry. */
const WINDOW_OPEN =
  "A browser window is opening on the user's screen for them to sign in by hand. Tell the user to complete it, including any 2FA, then ask them to say when they are done.";
const NEEDS_PASSWORD_FOR_HEADLESS =
  `No password is saved on this computer, so a sign-in with no window has nothing to type into the school's form and would only wait and time out. Either call sign_in again with visible true, or tell the user to run \`${SETUP_COMMAND}\` to save one.`;

/**
 * A sign-in still working is progress, not a failure, so these are not marked
 * isError: the shared guidance for them already tells the caller to come back
 * (each call polls the running sign-in), and isError invites a model to give
 * up or apologize instead.
 */
const STILL_WORKING: ReadonlySet<AuthFailureKind> = new Set<AuthFailureKind>([
  "mfaPending",
  "automaticPending",
  "inProgress",
]);

/**
 * Register sign_in tool.
 *
 * The counterpart to sign_out, and the reason it exists: an AI app had no way
 * to *start* a sign-in. Recovery happened only as a side effect of some other
 * tool hitting a 401, and the one documented fix for a first sign-in — open a
 * window — lived in an environment variable that nothing reachable from a
 * chat could set. So an assistant whose session had lapsed could only tell
 * the user to go and run a terminal command.
 *
 * What is specific to this tool is the decision to sign in at all, and the
 * window: the saved session is read first (TokenManager), so calling this
 * speculatively costs the user no MFA approval, and `visible`, left out,
 * opens a window exactly when the school's sign-in flow has nothing to sign
 * in with (no username, or no password and not passwordless), which is when a
 * headless sign-in can only time out.
 * A window cannot be asked of a sign-in already running, which keeps its own
 * mode, so busy() is checked before one is promised.
 *
 * Everything a *failure* should say is authPendingNotice's, not this file's:
 * the per-kind guidance, the MFA number, the dedup when a parallel call
 * already carried it, and the "ask for 2FA less often" tip. Writing that
 * wording again here would be a second policy to keep in step with
 * AuthRunner — and a wrong one, since the house guidance tells a caller to
 * keep calling while a sign-in polls, which is the opposite of what a
 * hand-written "do not retry" would say.
 */
export function registerSignIn(
  server: McpServer,
  config: AppConfig,
  tokenManager: Pick<TokenManager, "getToken" | "isValid">,
  authRunner?: Pick<AuthRunner, "run" | "busy" | "requestVisibleBrowser">
): void {
  server.registerTool(
    "sign_in",
    {
      title: "Sign In to Brightspace",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Sign in to Brightspace on this computer so the other tools work. Does nothing and says so if the saved session is already valid, so it is safe to call first when you are unsure. Opens a browser window for the user to sign in by hand when no password is saved (nothing to type means a windowless sign-in can only time out); otherwise it signs in in the background and reports the 2FA number for the user to approve on their phone. Call this when a Brightspace tool failed because of authentication, or when the user asks to sign in or log in to Brightspace. Every answer says what to do next, including whether to call again.",
      inputSchema: SignInSchema,
    },
    async ({ visible }) => {
      if (config.envAccessToken || config.envSessionCookie) return text(ENV_CREDENTIAL);
      if (!authRunner) return text(NO_RUNNER);

      // First, so signing in again when the saved session is fine never asks
      // the user for an approval they did not need to give.
      try {
        const token = await tokenManager.getToken();
        if (token && tokenManager.isValid(token)) return text(ALREADY);
      } catch (error) {
        // A session that cannot be read is exactly what signing in fixes.
        log("DEBUG", "sign_in could not read the saved session; signing in", error);
      }

      // The same test the sign-in itself makes before typing anything: each
      // school's flow decides. A passwordless account keeps no password yet
      // signs in without a window (the phone approves it).
      const canSignInHeadless = createSSOFlow(config).hasCredentials();
      // A window only when a headless sign-in could not work anyway.
      const wantWindow = visible ?? !canSignInHeadless;
      // A joined sign-in keeps the mode it started with, so asking would only
      // promise the user a window that never appears.
      const windowOpened = wantWindow && !authRunner.busy();
      if (windowOpened) authRunner.requestVisibleBrowser();
      else if (wantWindow) log("INFO", "sign_in was asked for a window but a sign-in is already running");
      if (!wantWindow && !canSignInHeadless) return text(NEEDS_PASSWORD_FOR_HEADLESS, true);

      try {
        await authRunner.run();
        return text(SUCCESS);
      } catch (error) {
        if (error instanceof AuthProcessError) {
          const guidance = authPendingNotice(error);
          return text(
            windowOpened ? `${WINDOW_OPEN} ${guidance}` : guidance,
            !STILL_WORKING.has(error.kind)
          );
        }
        // Everything else goes through the house path, which logs it and
        // keeps stack traces and raw responses out of the answer.
        return sanitizeError(error);
      }
    }
  );
}
