/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { ApiError, RateLimitError, NetworkError } from "../api/index.js";
import { log } from "../utils/logger.js";
import { AUTH_COMMAND } from "../utils/commands.js";
import { getUpdateNotice } from "../utils/update-checker.js";

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
 * Sanitize errors for user-friendly messages
 *
 * SECURITY: Never include stack traces, raw API responses, or token values
 */
export function sanitizeError(error: unknown): CallToolResult {
  // Log full error to stderr for debugging (token redaction handled by logger)
  log("ERROR", "Tool error", error);

  // Map to user-friendly messages
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
