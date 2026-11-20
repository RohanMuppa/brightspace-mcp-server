/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * The announcements phase of a full-course sync.
 */

import type { PhaseContext } from "./extras-types.js";

export interface AnnouncementsOutcome {
  /** Published announcements read. */
  read: number;
  withFiles: number;
  filesDownloaded: number;
  /** Announcements whose attachments could not be listed: never to be reported as "no attachments". */
  unknown: Array<{ newsId: number; title: string; reason: string }>;
  /** Set when the announcement list itself could not be read. */
  listUnreadable?: string;
  /** Announcements the run stopped before reaching. */
  notReached: number;
}

export const emptyAnnouncementsOutcome = (): AnnouncementsOutcome => ({ read: 0, withFiles: 0, filesDownloaded: 0, unknown: [], notReached: 0 });

export async function syncAnnouncements(_context: PhaseContext): Promise<AnnouncementsOutcome> {
  return emptyAnnouncementsOutcome();
}
