/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * Whether an item's last-modified timestamp is at or after a cutoff.
 *
 * A null or unparseable timestamp counts as a match, not a miss. D2L sends
 * null for some topics regardless of whether the item is new or old, and
 * excluding them would silently drop content from a filtered listing — the
 * same class of bug as #26, where graded work went missing from a listing
 * with no indication anything was withheld. Comparison happens on epoch
 * millis, which Date normalizes to UTC regardless of the source string's
 * offset, so timezone-qualified and Z-suffixed inputs compare correctly
 * against each other.
 */
export function matchesModifiedSince(
  lastModified: string | null | undefined,
  cutoff: Date
): boolean {
  if (!lastModified) return true;
  const time = new Date(lastModified).getTime();
  if (Number.isNaN(time)) return true;
  return time >= cutoff.getTime();
}
