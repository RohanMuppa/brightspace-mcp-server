/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT: see LICENSE file for details.
 */

const MAX_CAUSES = 4;
const MAX_LINE = 200;

/**
 * One safe line per link of an error's `cause` chain, outermost first, so a
 * failure reported as a wrapper ("could not verify the session") also logs
 * what actually broke. Only the first line of each message is kept, any URL
 * is cut to its origin (query strings and paths can carry tokens), and the
 * line is length-capped. The top error itself is not included.
 */
export function causeSummaries(error: unknown): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>([error]);
  let current: unknown = (error as { cause?: unknown } | null | undefined)?.cause;
  while (current !== undefined && current !== null && lines.length < MAX_CAUSES && !seen.has(current)) {
    seen.add(current);
    const raw = current instanceof Error ? current.message : typeof current === "string" ? current : "";
    const name = current instanceof Error && current.name !== "Error" ? `${current.name}: ` : "";
    const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
    const safe = `${name}${firstLine}`
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#)'"]+[^\s)'"]*/gi, (url) => {
        try { return new URL(url).origin; } catch { return "[url]"; }
      })
      .slice(0, MAX_LINE);
    lines.push(safe || "(no message)");
    current = (current as { cause?: unknown }).cause;
  }
  return lines;
}
