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
import type { NotRunReason, PhaseContext } from "./extras-types.js";
import type { AnnouncementRecord } from "./manifest.js";
import { NameSet, sanitizeComponent } from "./names.js";
import { NO_FILE_LIST, describeRead, nameCaps, positiveId } from "./submissions-sync.js";

export interface AnnouncementsOutcome {
  /** The top-level folder the announcement files were saved in. */
  folder: string;
  /** Set when the phase did not run because the run had already stopped: nothing was read, so no count here means anything. */
  notRun?: NotRunReason;
  /** Published announcements listed. `read + notReached + unusable` equals this. */
  listed: number;
  /** Published announcements read. */
  read: number;
  /** Announcements whose entry had no usable id. Each is also in `unknown`. */
  unusable: number;
  withFiles: number;
  filesDownloaded: number;
  /** Announcements whose attachments could not be listed: never to be reported as "no attachments". */
  unknown: Array<{ newsId: number; title: string; reason: string }>;
  /** Set when the announcement list itself could not be read. */
  listUnreadable?: string;
  /** Announcements the run stopped before reaching. */
  notReached: number;
  /** Announcements the run stopped in the middle of: some of their files were not saved. */
  partlySaved: number;
}

export const emptyAnnouncementsOutcome = (folder = "Announcements"): AnnouncementsOutcome => ({
  folder, listed: 0, read: 0, unusable: 0, withFiles: 0, filesDownloaded: 0, unknown: [], notReached: 0, partlySaved: 0,
});

const NAME_CHARS = 150;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export async function syncAnnouncements(ctx: PhaseContext): Promise<AnnouncementsOutcome> {
  const root = ctx.roots.announcements;
  const out = emptyAnnouncementsOutcome(root);
  const { apiClient, courseId, manifest } = ctx;

  const notRun = (): AnnouncementsOutcome => {
    out.notRun = ctx.notRunReason() ?? "cancelled";
    return out;
  };
  if (ctx.stopped()) return notRun();

  let raw: unknown;
  try {
    // Read fresh (no cache) so a cancel reaches the request and a new post is seen.
    raw = await apiClient.get<unknown>(apiClient.le(courseId, "/news/"), { signal: ctx.signal });
  } catch (error) {
    if (ctx.handleStop(error)) return notRun();
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
    if (parts.length === 2 && parts[0] === root) dirNames.add(parts[1], true);
  }
  const caps = nameCaps(ctx, root, 0);

  for (const rawItem of entries) {
    if (isRecord(rawItem) && rawItem.IsPublished === false) continue;
    const newsId = isRecord(rawItem) ? positiveId(rawItem.Id) : null;
    const title = isRecord(rawItem) && typeof rawItem.Title === "string" ? rawItem.Title : "";
    out.listed++;
    if (!isRecord(rawItem) || newsId === null) {
      out.unusable++;
      out.unknown.push({ newsId: 0, title, reason: "this announcement had no usable id, so its files were not looked for" });
      continue;
    }
    const item = rawItem as unknown as NewsItem;
    if (!isPublishedNewsItem(item)) continue;
    if (ctx.stopped()) {
      out.notReached++;
      continue;
    }
    out.read++;

    const attachments = rawItem.Attachments;
    if (!Array.isArray(attachments)) {
      out.unknown.push({ newsId, title, reason: NO_FILE_LIST });
      continue;
    }
    const files: Array<{ fileId: number; fileName: string }> = [];
    let unreadable = false;
    for (const file of attachments as unknown[]) {
      const fileId = isRecord(file) ? positiveId(file.FileId) : null;
      if (fileId === null) {
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
        dirRel = `${root}/${dirNames.add(sanitizeComponent(`${date} ${title}`, `${date} Announcement ${newsId}`, caps.dir), true, caps.dir)}`;
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
      let incomplete = false;
      for (const file of files) {
        const key = String(file.fileId);
        const sanitized = sanitizeComponent(file.fileName, `File ${file.fileId}`, caps.file);
        const result = await ctx.saveFile({
          segments: dirRel.split("/"),
          name: record.files[key] ? sanitized : names.add(sanitized, false, caps.file),
          prior: record.files[key],
          open: async (signal) => ({ response: await apiClient.getRaw(apiClient.le(courseId, `/news/${newsId}/attachments/${file.fileId}`), { signal }) }),
          onSaved: (entry) => {
            record.files[key] = entry;
            ctx.touch();
          },
        });
        if (result.status === "saved") out.filesDownloaded++;
        if (result.status === "notAttempted") incomplete = true;
      }
      if (incomplete) out.partlySaved++;
    } catch (error) {
      if (ctx.handleStop(error)) {
        out.partlySaved++;
        continue;
      }
      log("WARN", `Course sync: announcement ${newsId} could not be saved`, error);
      out.unknown.push({ newsId, title, reason: "Unexpected error" });
    }
  }
  return out;
}
