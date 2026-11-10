/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { SyncResult } from "./course-sync.js";

const MAX_LISTED = 20;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function list(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, MAX_LISTED).map((item) => `  ${item}`);
  if (items.length > MAX_LISTED) shown.push(`  ...and ${items.length - MAX_LISTED} more`);
  return [`${title}:`, ...shown];
}

/** A compact plain-text account of a sync: counts first, then the files that need attention. */
export function summarizeSync(result: SyncResult): string {
  const { nonFiles } = result;
  const lines: string[] = [];
  if (result.dryRun) {
    lines.push(`Dry run for course ${result.courseId}: ${plural(result.planned?.length ?? 0, "file")} would be downloaded to ${result.destination}. Nothing was downloaded or created.`);
  } else {
    lines.push(`Course ${result.courseId} saved to ${result.destination}: ${result.downloaded.length} downloaded, ${result.skippedExisting} already on disk, ${result.failed.length} failed, ${result.notAttempted} not attempted.`);
  }
  if (result.authError) {
    lines.push(`Stopped early because the Brightspace session is gone: ${result.authError}`);
    lines.push("Nothing already downloaded is lost; run it again after signing in and it will pick up where it stopped.");
  } else if (result.notAttempted > 0) {
    lines.push(`${plural(result.notAttempted, "file")} not attempted because of the file cap. Run it again to continue: files already on disk are skipped.`);
  }

  const skipped: string[] = [];
  if (nonFiles.link) skipped.push(`${plural(nonFiles.link, "web link")}`);
  if (nonFiles.media) skipped.push(`${plural(nonFiles.media, "embedded video/media item")} (download_file cannot fetch these)`);
  if (nonFiles.broken) skipped.push(`${plural(nonFiles.broken, "broken item")}`);
  if (nonFiles.other) skipped.push(`${plural(nonFiles.other, "other non-file item")} (quizzes, discussions, ...)`);
  if (nonFiles.unavailable) skipped.push(`${plural(nonFiles.unavailable, "file")} locked or not yet released`);
  if (skipped.length > 0) lines.push(`Not files, so not downloaded: ${skipped.join("; ")}. These are not missing from the sync.`);

  lines.push(...list("Would download", result.planned ?? []));
  lines.push(...list("Downloaded", result.downloaded.map((f) => f.path)));
  lines.push(...list("Failed", result.failed.map((f) => `${f.path}: ${f.error}`)));
  return lines.join("\n");
}
