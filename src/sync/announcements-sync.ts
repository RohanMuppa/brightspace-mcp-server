/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * The announcements phase of a full-course sync: the files attached to each
 * published announcement, in a folder named by its date and title.
 */

import { effectiveDate, isPublishedNewsItem, type NewsItem } from "../tools/get-announcements.js";
import { log } from "../utils/logger.js";
import type { PhaseContext } from "./extras-types.js";
import type { AnnouncementRecord } from "./manifest.js";
import { NameSet, sanitizeComponent } from "./names.js";
import { describeRead } from "./submissions-sync.js";

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

const NAME_CHARS = 150;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export async function syncAnnouncements(ctx: PhaseContext): Promise<AnnouncementsOutcome> {
  const out = emptyAnnouncementsOutcome();
  const { apiClient, courseId, manifest } = ctx;

  let raw: unknown;
  try {
    // Read fresh (no cache) so a cancel reaches the request and a new post is seen.
    raw = await apiClient.get<unknown>(apiClient.le(courseId, "/news/"), { signal: ctx.signal });
  } catch (error) {
    if (ctx.handleStop(error)) return out;
    // A 404 is how Brightspace says the course has no announcements tool: known, not unreadable.
    if ((error as { status?: unknown } | null)?.status !== 404) out.listUnreadable = describeRead(error);
    return out;
  }
  const entries = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.Objects) ? raw.Objects : null;
  if (entries === null) {
    out.listUnreadable = "Brightspace answered in a shape the sync does not read";
    return out;
  }

  const dirNames = new NameSet(NAME_CHARS);
  for (const [, record] of manifest.announcementRecords(courseId)) {
    const parts = record.dir.split("/");
    if (parts.length === 2 && parts[0] === "Announcements") dirNames.add(parts[1], true);
  }

  for (const rawItem of entries) {
    if (!isRecord(rawItem)) continue;
    const item = rawItem as unknown as NewsItem;
    const newsId = Number(item.Id);
    if (!Number.isSafeInteger(newsId) || newsId <= 0 || !isPublishedNewsItem(item)) continue;
    if (ctx.stopped()) {
      out.notReached++;
      continue;
    }
    out.read++;
    const title = typeof item.Title === "string" ? item.Title : "";

    const attachments = (rawItem as { Attachments?: unknown }).Attachments;
    if (attachments !== undefined && attachments !== null && !Array.isArray(attachments)) {
      out.unknown.push({ newsId, title, reason: "Brightspace listed the attachments in a shape the sync does not read" });
      continue;
    }
    const files: Array<{ fileId: number; fileName: string }> = [];
    let unreadable = false;
    for (const file of (attachments ?? []) as unknown[]) {
      const fileId = isRecord(file) ? Number(file.FileId) : NaN;
      if (!Number.isSafeInteger(fileId) || fileId <= 0) {
        unreadable = true;
        break;
      }
      files.push({ fileId, fileName: typeof (file as Record<string, unknown>).FileName === "string" ? ((file as Record<string, unknown>).FileName as string) : `File ${fileId}` });
    }
    if (unreadable) {
      out.unknown.push({ newsId, title, reason: "Brightspace listed an attachment in a shape the sync does not read" });
      continue;
    }
    if (files.length === 0) continue;
    out.withFiles++;

    try {
      const existingRecord = manifest.findAnnouncement(courseId, newsId);
      let dirRel = existingRecord?.dir;
      if (!dirRel) {
        const date = /^\d{4}-\d{2}-\d{2}/.exec(effectiveDate(item) ?? "")?.[0] ?? "undated";
        dirRel = `Announcements/${dirNames.add(sanitizeComponent(`${date} ${title}`, `${date} Announcement ${newsId}`, NAME_CHARS), true)}`;
      }
      const record: AnnouncementRecord = ctx.dryRun
        ? existingRecord ?? { dir: dirRel, files: Object.create(null) }
        : manifest.announcement(courseId, newsId);
      if (!ctx.dryRun) {
        record.dir = dirRel;
        ctx.touch();
      }
      const names = new NameSet(NAME_CHARS);
      for (const entry of Object.values(existingRecord?.files ?? {})) {
        if (entry.path.startsWith(`${dirRel}/`) && !entry.path.slice(dirRel.length + 1).includes("/")) names.add(entry.path.slice(dirRel.length + 1));
      }
      for (const file of files) {
        const key = String(file.fileId);
        const sanitized = sanitizeComponent(file.fileName, `File ${file.fileId}`, NAME_CHARS);
        const result = await ctx.saveFile({
          segments: dirRel.split("/"),
          name: record.files[key] ? sanitized : names.add(sanitized),
          prior: record.files[key],
          open: async (signal) => ({ response: await apiClient.getRaw(apiClient.le(courseId, `/news/${newsId}/attachments/${file.fileId}`), { signal }) }),
          onSaved: (entry) => {
            record.files[key] = entry;
            ctx.touch();
          },
        });
        if (result.status === "saved") out.filesDownloaded++;
      }
    } catch (error) {
      if (ctx.handleStop(error)) {
        out.notReached++;
        continue;
      }
      log("WARN", `Course sync: announcement ${newsId} could not be saved`, error);
      out.unknown.push({ newsId, title, reason: "Unexpected error" });
    }
  }
  return out;
}
