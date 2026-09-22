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
import { AUTH_COMMAND } from "../utils/commands.js";
import { getUpdateNotice } from "../utils/update-checker.js";
import {
  DownloadError,
  isSafeDetail,
  type DownloadFailureKind,
} from "../utils/download-errors.js";

/**
 * Wrap data as MCP-compatible tool result.
 *
 * Every tool returns through here, which makes it the one place an update
 * notice can reach a user regardless of which tool they happen to call. The
 * notice is appended as a separate content block so content[0].text stays a
 * pure JSON document for anything parsing it, and it is throttled inside
 * getUpdateNotice so a busy session is not spammed.
 */
export function toolResponse(data: unknown): CallToolResult {
  const content: CallToolResult["content"] = [
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
    `Run \`${AUTH_COMMAND}\` in a terminal to retry now and see the number to enter.`,
  unsupported:
    "This login needs something your AI client cannot supply, usually a code from an "
    + "authenticator app. " +
    `Run \`${AUTH_COMMAND}\` in a terminal and sign in there.`,
  secureStorage:
    "The operating system credential store is locked or unavailable, so the saved " +
    "password could not be read. Unlock your keychain or keyring, then try again.",
  transport:
    "Brightspace could not be reached to sign in. The saved session was kept. " +
    "Check your connection and try again in a few minutes.",
  timeout:
    "The sign-in did not finish in time, usually a missed MFA prompt. " +
    `Run \`${AUTH_COMMAND}\` in a terminal to complete it with the number visible.`,
  failed:
    `The sign-in did not complete. Run \`${AUTH_COMMAND}\` in a terminal to see why, ` +
    "or `brightspace-setup` if your saved school or username is wrong.",
  mfaPending:
    "A Microsoft Authenticator approval was not completed in time. Try again.",
};

/**
 * mfaPending is the one kind whose guidance is partly dynamic: `numberMatch`
 * on AuthProcessError, unlike its `message`, is populated only from a
 * strictly `/^\d{1,3}$/`-matched marker the child process printed (see
 * auth-runner.ts MFA_NUMBER_MARKER) — a bounded, pre-validated value, not
 * arbitrary child output, so it is safe to interpolate here.
 */
function authFailureMessage(error: AuthProcessError): string {
  if (error.kind === "mfaPending" && error.numberMatch) {
    return `Open Microsoft Authenticator and enter ${error.numberMatch} within 5 minutes, then run this again.`;
  }
  return AUTH_FAILURE_GUIDANCE[error.kind];
}

/**
 * What to tell someone when a download fails.
 *
 * Same contract as AUTH_FAILURE_GUIDANCE: keyed off a kind this package
 * assigns, never off the caught message, so a Content-Disposition header or a
 * file body cannot put words in a tool response. The only value that crosses
 * from the remote side is a detected MIME type, and only after isSafeDetail
 * confirms it is a bare type token.
 */
const DOWNLOAD_FAILURE_GUIDANCE: Record<DownloadFailureKind, string> = {
  unsupportedType:
    "The file's format is not on the allowed download list. " +
    "Open it from Brightspace in a browser instead.",
  undetectableType:
    "The file's format could not be identified, so it was not saved. " +
    "This usually means Brightspace returned an error page instead of the file.",
  badFilename:
    "The name Brightspace gave this file cannot be used on disk. " +
    "Pass customFilename to choose one yourself.",
  pathTraversal:
    "The name Brightspace gave this file pointed outside the download " +
    "directory and was refused. Pass customFilename to choose one yourself.",
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
      `Could not sign in to Brightspace automatically. ${authFailureMessage(error)}`
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
  // Without this every validation failure lands in the generic fallback, which
  // is how a .doc download reported nothing more than "unexpected error".
  if (error instanceof DownloadError) {
    const detail =
      error.detail && isSafeDetail(error.detail)
        ? ` (detected type: ${error.detail})`
        : "";
    return errorResponse(
      `Could not save the file.${detail} ${DOWNLOAD_FAILURE_GUIDANCE[error.kind]}`
    );
  }

  if (error instanceof ApiError) {
    if (error.status === 404) {
      return errorResponse(
        "Resource not found. The course or item may not exist, or you may not have access."
      );
    }
    if (error.status === 401) {
      // A stale install is a common cause of sign-in failing, so this is the
      // one error worth attaching the update notice to.
      const result = errorResponse(
        "Authentication expired. Auto-reauthentication was attempted but failed. " +
        `Please run \`${AUTH_COMMAND}\` in your terminal, then try again.`
      );
      const notice = getUpdateNotice();
      if (notice) result.content.push({ type: "text", text: notice });
      return result;
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
