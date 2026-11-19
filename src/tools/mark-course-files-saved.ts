/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { MarkCourseFilesSavedSchema } from "./schemas.js";
import { errorResponse, sanitizeError, toolResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { validateContentId } from "../utils/file-validator.js";
import { planFiles } from "../sync/course-sync.js";
import { ledgerFailureReason, markTopics, unmarkTopics, type MarkItem } from "../sync/saved-topics.js";
import { diffCourse } from "./get-unsaved-course-files.js";

/** Why a path cannot be recorded, or the size of the file if it can. */
async function checkPath(file: string): Promise<{ size: number } | { reason: string }> {
  if (!path.isAbsolute(file) || file.includes("\u0000")) return { reason: "the path must be absolute" };
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? { size: stat.size } : { reason: "the path is not a file" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { reason: code === "ENOENT" || code === "ENOTDIR" ? "the file does not exist" : `the path could not be checked${typeof code === "string" ? ` (${code})` : ""}` };
  }
}

/**
 * Register mark_course_files_saved tool
 */
export function registerMarkCourseFilesSaved(server: McpServer, apiClient: D2LApiClient): void {
  server.registerTool(
    "mark_course_files_saved",
    {
      title: "Mark Course Files Saved",
      // Not read-only: it writes the server's own record of what the student has. It never writes a course file.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        "Record that the student already has some of a course's files, without downloading them, so get_unsaved_course_files stops listing them. This writes only the server's own record (a small file in the server's settings folder); it never writes, moves or deletes a course file. Use it only when the student says they already have those files. Ask the student which ones before marking; ask the student before marking everything (allUnsaved), and never mark files as saved to make a list shorter or because a download is slow. Give topics: a list of { topicId, path? } with ids from get_unsaved_course_files; add the absolute path of the student's copy when known (it must exist now, and later a missing file is reported like any saved file). A topic marked without a path counts as saved but the server never checks a file for it (markedSavedCount). allUnsaved: true marks every topic that is unsaved right now, and is refused if the saved records could not be read. unmarkTopicIds forgets the record for topics (including a download's record) and never deletes a file. Name exactly one of topics, allUnsaved or unmarkTopicIds. Each item is checked against the course's current file topics and refused with a reason if it is not one, or if its path is bad; the others still go through. If the answer says marking failed, nothing was recorded: tell the student, do not pretend it worked.",
      inputSchema: MarkCourseFilesSavedSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "mark_course_files_saved tool called", { args: { ...args, topics: undefined } });
        const { courseId, topics, allUnsaved, unmarkTopicIds } = MarkCourseFilesSavedSchema.parse(args);
        validateContentId(courseId);
        const named = [topics !== undefined, allUnsaved === true, unmarkTopicIds !== undefined].filter(Boolean).length;
        if (named !== 1) {
          return errorResponse("Name exactly one of topics, allUnsaved: true, or unmarkTopicIds. Nothing was marked.", "invalidInput");
        }

        const failed = (error: unknown) =>
          errorResponse(`Marking failed, nothing was recorded: ${ledgerFailureReason(error)}. Tell the student; do not say the files were marked.`);

        {
          if (unmarkTopicIds !== undefined) {
            let outcome;
            try {
              outcome = await unmarkTopics(apiClient.origin, courseId, [...new Set(unmarkTopicIds)]);
            } catch (error) {
              return failed(error);
            }
            const { removed, notRecorded } = outcome;
            return toolResponse({
              courseId,
              unmarked: removed,
              notRecorded,
              note: "unmarked topics are no longer recorded as saved and will be listed as unsaved again. No file was touched. A topic saved by download_course_files or sync is recorded in that folder's manifest, not here, and is not affected.",
            });
          }

          // The live course decides what counts as a file topic.
          let candidates: Array<{ topicId: number; path?: string }>;
          let fileIds: Set<number>;
          let allIds: Set<number>;
          if (allUnsaved === true) {
            const diff = await diffCourse(apiClient, courseId, undefined, []);
            if (diff.state.unreadable.length > 0 || diff.plan.truncated || diff.plan.unreadEntries > 0) {
              return errorResponse(
                "Refused: the saved records or the course's table of contents could not be read, so which topics are unsaved is not known. Nothing was marked. Run get_unsaved_course_files to see why, or mark specific topics with topics.",
              );
            }
            candidates = diff.unsaved.map((entry) => ({ topicId: entry.topicId }));
            fileIds = new Set(candidates.map((c) => c.topicId));
            allIds = fileIds;
          } else {
            const toc = await apiClient.get<unknown>(apiClient.le(courseId, "/content/toc"));
            const plan = planFiles(toc, undefined, new Map());
            fileIds = new Set(plan.files.map((file) => file.topicId));
            // Ids of any non-file topic are unknown to the plan, so "not a file" and "not in this course" are told apart by the raw table.
            allIds = collectTopicIds(toc);
            candidates = topics!;
          }

          const refused: Array<{ topicId: number; reason: string }> = [];
          const items: MarkItem[] = [];
          const seen = new Set<number>();
          for (const candidate of candidates) {
            if (seen.has(candidate.topicId)) continue;
            seen.add(candidate.topicId);
            if (!fileIds.has(candidate.topicId)) {
              refused.push({
                topicId: candidate.topicId,
                reason: allIds.has(candidate.topicId)
                  ? "not a file topic (a link, embedded media, quiz or other item has no file to save)"
                  : "not in this course's table of contents",
              });
              continue;
            }
            if (candidate.path === undefined) {
              items.push({ topicId: candidate.topicId });
              continue;
            }
            const checked = await checkPath(candidate.path);
            if ("reason" in checked) refused.push({ topicId: candidate.topicId, reason: checked.reason });
            else items.push({ topicId: candidate.topicId, path: candidate.path, size: checked.size });
          }

          let outcome;
          try {
            outcome = await markTopics(apiClient.origin, courseId, items);
          } catch (error) {
            return failed(error);
          }
          const { marked, keptExisting } = outcome;
          log("INFO", `mark_course_files_saved: course ${courseId}: ${marked.length} marked, ${refused.length} refused`);
          return toolResponse({
            courseId,
            marked: marked.map((topicId) => {
              const item = items.find((entry) => entry.topicId === topicId)!;
              return { topicId, ...(item.path !== undefined ? { path: item.path } : {}) };
            }),
            refused,
            alreadyRecorded: keptExisting.map((topicId) => ({ topicId, note: "already recorded as saved at a path; kept" })),
            note: "Marked topics count as saved in get_unsaved_course_files. A topic marked without a path was never checked against a file. Use unmarkTopicIds to undo.",
          });
        }
      } catch (error) {
        // Reading the course failing (sign-in and the like) goes through the usual handling.
        return sanitizeError(error);
      }
    }
  );
}

/** Every topic id the table lists, of any type. */
function collectTopicIds(toc: unknown): Set<number> {
  const ids = new Set<number>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 64 || node === null || typeof node !== "object") return;
    const container = node as Record<string, unknown>;
    for (const topic of Array.isArray(container.Topics) ? container.Topics : []) {
      const id = Number((topic as Record<string, unknown> | null)?.TopicId ?? (topic as Record<string, unknown> | null)?.Id);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
    for (const child of Array.isArray(container.Modules) ? container.Modules : []) walk(child, depth + 1);
  };
  walk(toc, 0);
  return ids;
}
