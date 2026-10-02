/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const relativeTimeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * Render a due date as a short relative phrase ("in 3 days", "yesterday",
 * "in 2 hours") so a caller doesn't have to do date math on a raw ISO
 * timestamp itself. Unit scales with magnitude: minutes under an hour, hours
 * under a day, days under a week, weeks beyond that.
 *
 * Returns `null` for a missing or unparseable date rather than throwing —
 * D2L-supplied date strings aren't guaranteed well-formed (same guard as
 * JhostinAleck/brightspace-mcp's `shared-kernel/date/parseValidDate.ts`, MIT).
 *
 * `now` defaults to `Date.now()`; tests pin it with fake timers.
 */
export function dueIn(dueDate: string | null | undefined, now: number = Date.now()): string | null {
  if (!dueDate) return null;
  const due = new Date(dueDate).getTime();
  if (!Number.isFinite(due)) return null;

  const diffMs = due - now;
  const absMs = Math.abs(diffMs);

  if (absMs < HOUR_MS) {
    return relativeTimeFormat.format(Math.round(diffMs / MINUTE_MS), "minute");
  }
  if (absMs < DAY_MS) {
    return relativeTimeFormat.format(Math.round(diffMs / HOUR_MS), "hour");
  }
  if (absMs < WEEK_MS) {
    return relativeTimeFormat.format(Math.round(diffMs / DAY_MS), "day");
  }
  return relativeTimeFormat.format(Math.round(diffMs / WEEK_MS), "week");
}
