/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * A diagnostic category for a failed tool call, chosen from a closed set this
 * package controls. Derived from the error's type and status only, never from
 * its message, so the dev activity log can say why a call failed without
 * recording paths, URLs, arguments, or content.
 */

import { ZodError } from "zod";
import { ApiError, NetworkError } from "../api/errors.js";
import { AuthProcessError } from "../auth/auth-runner.js";
import { DownloadError } from "./download-errors.js";

export const ERROR_KINDS = ["invalidInput", "destination", "notFound", "permission", "auth", "rateLimited", "http",
  "transport", "providerBlocked", "unsupportedFormat", "rejectedFile", "unknown"] as const;
export type ErrorKind = typeof ERROR_KINDS[number];

const API_STATUS_KINDS: Partial<Record<number, ErrorKind>> = {
  401: "auth", 403: "permission", 404: "notFound", 429: "rateLimited",
};

export function errorKind(error: unknown): ErrorKind {
  if (error instanceof ZodError) return "invalidInput";
  if (error instanceof AuthProcessError) return "auth";
  if (error instanceof ApiError) return API_STATUS_KINDS[error.status] ?? "http";
  if (error instanceof NetworkError) return "transport";
  if (error instanceof DownloadError) {
    return error.kind === "unsupportedType" || error.kind === "undetectableType" ? "unsupportedFormat" : "rejectedFile";
  }
  return "unknown";
}

const resultKinds = new WeakMap<object, ErrorKind>();

/** Remembers which error a returned tool result describes. */
export function withErrorKind<T extends object>(result: T, error: unknown): T {
  return tagErrorKind(result, errorKind(error));
}

/** Records the category of an error result a tool built itself. */
export function tagErrorKind<T extends object>(result: T, kind: ErrorKind): T {
  resultKinds.set(result, kind);
  return result;
}

/** The category of a returned error result; "unknown" when no error was attached. */
export function resultErrorKind(result: unknown): ErrorKind {
  return (typeof result === "object" && result !== null && resultKinds.get(result)) || "unknown";
}
