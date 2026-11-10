/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { log } from "../utils/logger.js";

/** A partial download older than this belongs to a run that was killed, not one still going. */
export const PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;
/** Exactly what secureStreamDownload names its temporary file. */
const PARTIAL = /^\.download-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;
const MAX_VISITED = 50_000;
const MAX_DEPTH = 64;

/**
 * Remove the `.download-<uuid>.part` files a killed run (kill -9, power loss)
 * left in the destination tree. Only that exact name, only regular files
 * older than an hour, and nothing is followed through a symbolic link or into
 * a hidden folder. Returns how many were removed.
 */
export async function removeStalePartials(root: string, now: number = Date.now()): Promise<number> {
  let removed = 0;
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || visited > MAX_VISITED) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++visited > MAX_VISITED) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk(full, depth + 1);
      } else if (entry.isFile() && PARTIAL.test(entry.name)) {
        try {
          // lstat again: the entry type above could have changed, and a link is never touched.
          const stat = await fs.lstat(full);
          if (stat.isFile() && now - stat.mtimeMs > PARTIAL_MAX_AGE_MS) {
            await fs.rm(full, { force: true });
            removed++;
          }
        } catch {
          // Gone already, or not ours to remove.
        }
      }
    }
  };
  await walk(root, 0);
  if (removed > 0) log("INFO", `Course sync: removed ${removed} partial download(s) left by an interrupted run`);
  return removed;
}
