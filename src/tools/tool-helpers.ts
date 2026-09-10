/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { ApiError, RateLimitError, NetworkError } from "../api/index.js";
import { TokenRefreshError } from "../api/errors.js";
import { AuthProcessError, type AuthFailureKind } from "../auth/auth-runner.js";
import { log } from "../utils/logger.js";
import { getUpdateNotice } from "../utils/update-checker.js";

/**
 * Wrap data as MCP-compatible tool result
 *
 * An available-update notice rides along on the first successful result that
 * follows the startup check. This used to be check_auth's job; with
 * authentication folded into the tools themselves there is no call the user
 * reliably makes, so it attaches here. getUpdateNotice() clears itself, so the
 * notice appears once per server run.
 */
export function toolResponse(data: unknown): CallToolResult {
  const content: Array<{ type: "text"; text: string }> = [
    {
      type: "text",
      text: JSON.stringify(data, null, 2),
    },
  ];

  const notice = getUpdateNotice();
  if (notice) content.push({ type: "text", text: notice });

  return { content };
}

/**
 * Wrap error message as MCP-compatible tool result
 */
export function errorResponse(message: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

/**
 * What to tell the user for each way an automatic sign-in can fail.
 *
 * Authentication is the one failure mode where "an unexpected error occurred"
 * costs the user a fix they could apply themselves, and it now happens inside
 * an ordinary tool call rather than in a dedicated auth step. The text is
 * keyed off AuthProcessError.kind, a closed set this package assigns itself;
 * nothing is derived from the caught message, so a child process cannot put
 * words in the response. The full error still goes to the log.
 */
const AUTH_FAILURE_GUIDANCE: Record<AuthFailureKind, string> = {
  busy: "A sign-in is already running in another process. Let it finish, then try again.",
  cooldown:
    "Automatic sign-in is paused because an MFA prompt went unanswered. " +
    "Run `brightspace-auth` in a terminal to retry now and see the number to enter.",
  unsupported:
    "This school's login page cannot be completed without a person at the keyboard. " +
    "Run `brightspace-auth` in a terminal and sign in there.",
  secureStorage:
    "The operating system credential store is locked or unavailable, so the saved " +
    "password could not be read. Unlock your keychain or keyring, then try again.",
  transport:
    "Brightspace could not be reached to sign in. The saved session was kept. " +
    "Check your connection and try again in a few minutes.",
  timeout:
    "The sign-in did not finish in time, usually a missed MFA prompt. " +
    "Run `brightspace-auth` in a terminal to complete it with the number visible.",
  failed:
    "The sign-in did not complete. Run `brightspace-auth` in a terminal to see why, " +
    "or `brightspace-setup` if your saved school or username is wrong.",
};

/**
 * Sanitize errors for user-friendly messages
 *
 * SECURITY: Never include stack traces, raw API responses, or token values
 */
export function sanitizeError(error: unknown): CallToolResult {
  // Log full error to stderr for debugging (token redaction handled by logger)
  log("ERROR", "Tool error", error);

  // Authentication runs inside the tool call now, so its failures surface
  // here rather than from a dedicated auth tool. Checked first: the kind
  // carries guidance that the generic branches below would throw away.
  if (error instanceof AuthProcessError) {
    return errorResponse(
      `Could not sign in to Brightspace automatically. ${AUTH_FAILURE_GUIDANCE[error.kind]}`
    );
  }

  // Checked before NetworkError, which it extends: a token service that is
  // briefly down is not a dead internet connection, and the saved session
  // survives it.
  if (error instanceof TokenRefreshError) {
    return errorResponse(
      "Brightspace could not renew your session right now. Your saved login was kept. " +
      "Try again in a few minutes."
    );
  }

  // Map to user-friendly messages
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return errorResponse(
        "Resource not found. The course or item may not exist, or you may not have access."
      );
    }
    if (error.status === 401) {
      return errorResponse(
        "Authentication expired. Auto-reauthentication was attempted but failed. " +
        "Please run `brightspace-auth` manually in your terminal, then try again."
      );
    }
    if (error.status === 403) {
      return errorResponse(
        "Access denied. You may not have permission to access this resource."
      );
    }
  }

  if (error instanceof RateLimitError) {
    return errorResponse(
      "Rate limited by Brightspace. Please wait a moment and try again."
    );
  }

  if (error instanceof NetworkError) {
    return errorResponse(
      "Could not connect to Brightspace. Check your internet connection."
    );
  }

  if (error instanceof ZodError) {
    const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return errorResponse(`Invalid input: ${issues.join(", ")}`);
  }

  // Default fallback
  return errorResponse("An unexpected error occurred. Please try again.");
}
