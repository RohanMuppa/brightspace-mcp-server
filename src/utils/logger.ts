/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { LogLevel } from "../types/index.js";

let currentLevel: LogLevel = "INFO";

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Redact sensitive patterns from log output.
 * Tokens, passwords, and secrets are replaced with first 8 chars + "...REDACTED".
 *
 * Deliberately no blanket uppercase or base32 rule: it would eat course codes
 * like ECE264, which are exactly what a useful log line contains.
 */
function redact(value: string): string {
  // JSON web tokens, wherever they appear
  value = value.replace(
    /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g,
    "eyJ...REDACTED"
  );
  // Redact Bearer tokens
  value = value.replace(
    /Bearer\s+([A-Za-z0-9._~+/=-]{8})[A-Za-z0-9._~+/=-]*/g,
    "Bearer $1...REDACTED"
  );
  // Redact cookie: prefixed tokens
  value = value.replace(
    /cookie:([^\s]{8})[^\s]*/g,
    "cookie:$1...REDACTED"
  );
  // JSON-serialized header fields: {"Authorization":"..."}, {"Cookie":"..."}
  value = value.replace(
    /("(?:authorization|cookie|set-cookie)"\s*:\s*")[^"]*(")/gi,
    "$1...REDACTED$2"
  );
  // Credentials embedded in a URL: scheme://user:pass@host
  value = value.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    "$1***:***@"
  );
  // Redact anything that looks like a long token (40+ chars of base64-like)
  value = value.replace(
    /([A-Za-z0-9._~+/=-]{40,})/g,
    (match) => match.substring(0, 8) + "...REDACTED"
  );
  return value;
}

const MAX_ARG_LENGTH = 2000;

/**
 * Turn a log argument into text so the redactor can see inside it. Errors
 * keep their name, message, and first stack frame; objects are serialized
 * with cycles broken; everything else is stringified.
 */
function serializeArg(arg: unknown): string {
  if (arg instanceof Error) {
    const frame = arg.stack?.split("\n").find((line) => line.trim().startsWith("at ")) ?? "";
    return `${arg.name}: ${arg.message}${frame ? ` ${frame.trim()}` : ""}`;
  }
  if (typeof arg === "string") return arg;
  if (typeof arg === "object" && arg !== null) {
    const seen = new WeakSet<object>();
    try {
      const json = JSON.stringify(arg, (_key, value) => {
        if (typeof value === "bigint") return value.toString();
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
        }
        return value;
      });
      return json.length > MAX_ARG_LENGTH ? `${json.slice(0, MAX_ARG_LENGTH)}...` : json;
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

export function log(
  level: LogLevel,
  message: string,
  ...args: unknown[]
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const timestamp = new Date().toISOString();
  const safeMessage = redact(message);
  const safeArgs = args.map((arg) => redact(serializeArg(arg)));
  console.error(`[${timestamp}] [${level}] ${safeMessage}`, ...safeArgs);
}

// Override console.log in production to prevent accidental stdout writes
export function enableStdoutGuard(): void {
  console.log = (...args: unknown[]) => {
    console.error(
      "[WARN] console.log intercepted (would corrupt stdio):",
      ...args,
    );
  };
}
