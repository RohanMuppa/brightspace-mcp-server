/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Adapted from @el2060's fork (el2060/brightspace-mcp-server, MIT) —
// permission handling rewritten to this project's ApiError/sanitizeError
// conventions and courseId naming.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, ApiError, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetDropboxSubmissionsSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

// D2L submission API types (instructor/TA view — every submitter, not just "mine")
interface D2LSubmissionFile {
  FileId: number;
  FileName: string;
  Size: number;
}

interface D2LSubmission {
  Id: number;
  SubmittedBy: { Identifier: string; DisplayName: string };
  SubmissionDate: string;
  Comment: { Text: string; Html: string } | null;
  Files: D2LSubmissionFile[];
}

interface D2LFeedback {
  Score: number | null;
  Feedback: { Text: string; Html: string } | null;
  IsGraded: boolean;
}

interface D2LDropboxFolder {
  Id: number;
  Name: string;
  DueDate: string | null;
  Assessment: { ScoreDenominator: number | null } | null;
}

// Per-submitter feedback lookup is one GET each; cap how many run at once so
// a large dropbox folder can't fan out hundreds of concurrent requests.
const FEEDBACK_FETCH_CONCURRENCY = 8;

/** Run `fn` over `items`, at most `concurrency` in flight at a time. */
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
}

/**
 * Register get_dropbox_submissions tool.
 */
export function registerGetDropboxSubmissions(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_dropbox_submissions",
    {
      title: "Get Dropbox Submissions",
      description:
        "List every student's (or group's) submission to a dropbox folder, for an instructor or TA — " +
        "submitter names, submission dates, late status, file lists, and feedback/grading status. " +
        "Use get_dropbox_folders first to find folderId. Requires instructor or TA access; a student " +
        "account gets a clear note instead of data (a student's own download_file / get_assignments " +
        "already cover their own submission). Results are capped by limit (default 100, max 1000); " +
        "a truncated response says so and only fetches feedback for the returned slice.",
      inputSchema: GetDropboxSubmissionsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_dropbox_submissions tool called", { args });

        const { courseId, folderId, activeOnly, ignoreFeedback, limit } =
          GetDropboxSubmissionsSchema.parse(args);

        const folderPath = apiClient.le(courseId, "/dropbox/folders/");
        const submissionsPath = apiClient.le(
          courseId,
          `/dropbox/folders/${folderId}/submissions/`
        );

        let rawSubmissions: D2LSubmission[];
        let folder: D2LDropboxFolder | null = null;

        try {
          const [foldersRaw, submissionsRaw] = await Promise.all([
            apiClient.get<{ Objects: D2LDropboxFolder[] } | D2LDropboxFolder[]>(
              folderPath,
              { ttl: DEFAULT_CACHE_TTLS.assignments }
            ),
            apiClient.get<{ Objects: D2LSubmission[] } | D2LSubmission[]>(submissionsPath),
          ]);

          const allFolders = Array.isArray(foldersRaw) ? foldersRaw : foldersRaw.Objects ?? [];
          folder = allFolders.find((f) => f.Id === folderId) ?? null;

          rawSubmissions = Array.isArray(submissionsRaw) ? submissionsRaw : submissionsRaw.Objects ?? [];
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            return errorResponse(
              "Instructor or TA access required for this course. This tool reads every student's " +
              "dropbox submissions, which Brightspace only grants to course staff."
            );
          }
          if (error instanceof ApiError && error.status === 404) {
            return toolResponse({
              courseId,
              folderId,
              folderName: null,
              dueDate: null,
              submissions: [],
              note: `Dropbox folder ${folderId} not found in course ${courseId}.`,
            });
          }
          throw error;
        }

        if (rawSubmissions.length === 0) {
          return toolResponse({
            courseId,
            folderId,
            folderName: folder?.Name ?? null,
            dueDate: folder?.DueDate ?? null,
            submissions: [],
            note: "No submissions found for this dropbox folder.",
          });
        }

        // Cap the fan-out up front: a large dropbox folder could otherwise
        // mean hundreds of concurrent per-submitter feedback GETs and an
        // unbounded payload. Only the kept slice gets a feedback lookup.
        const total = rawSubmissions.length;
        const truncated = total > limit;
        const kept = truncated ? rawSubmissions.slice(0, limit) : rawSubmissions;

        // Optionally fetch feedback for each kept submitter, a bounded
        // number at a time. Best-effort: a submitter with no feedback yet
        // simply has none in the map.
        const feedbackMap = new Map<string, D2LFeedback>();
        if (!ignoreFeedback) {
          await mapWithConcurrency(kept, FEEDBACK_FETCH_CONCURRENCY, async (sub) => {
            try {
              const userId = sub.SubmittedBy.Identifier;
              const feedbackPath = apiClient.le(
                courseId,
                `/dropbox/folders/${folderId}/feedback/user/${userId}`
              );
              const fb = await apiClient.get<D2LFeedback>(feedbackPath);
              feedbackMap.set(userId, fb);
            } catch {
              // No feedback yet, or this submitter's feedback route
              // otherwise failed — silently skip, matching the "not
              // graded yet" default below.
            }
          });
        }

        const dueDate = folder?.DueDate ? new Date(folder.DueDate) : null;
        const maxScore = folder?.Assessment?.ScoreDenominator ?? null;

        const submissions = kept.map((sub) => {
          const userId = sub.SubmittedBy.Identifier;
          const submittedAt = new Date(sub.SubmissionDate);
          const isLate = dueDate !== null && submittedAt > dueDate;
          const feedback = feedbackMap.get(userId) ?? null;

          const entry: Record<string, unknown> = {
            submissionId: sub.Id,
            userId,
            displayName: sub.SubmittedBy.DisplayName,
            submittedDate: sub.SubmissionDate,
            isLate,
            files: sub.Files.map((f) => ({
              fileId: f.FileId,
              name: f.FileName,
              size: f.Size,
            })),
            comment: sub.Comment?.Text ?? null,
          };

          if (!ignoreFeedback) {
            entry.feedbackStatus = feedback
              ? {
                  isGraded: feedback.IsGraded,
                  score: feedback.Score,
                  maxScore,
                  hasFeedbackText: !!feedback.Feedback?.Text,
                }
              : { isGraded: false, score: null, maxScore, hasFeedbackText: false };
          }

          return entry;
        });

        // activeOnly: skip submissions that are already fully graded.
        const filtered =
          activeOnly && !ignoreFeedback
            ? submissions.filter((s) => !(s.feedbackStatus as any)?.isGraded)
            : submissions;

        log(
          "INFO",
          `get_dropbox_submissions: ${filtered.length} submissions (of ${total} total) for folder ${folderId}`,
          { truncated }
        );

        return toolResponse({
          courseId,
          folderId,
          folderName: folder?.Name ?? null,
          dueDate: folder?.DueDate ?? null,
          maxScore,
          totalSubmissions: total,
          returnedSubmissions: filtered.length,
          truncated,
          ...(truncated
            ? { note: `Showing ${kept.length} of ${total} submissions. Raise the limit argument to see more.` }
            : {}),
          activeOnly,
          submissions: filtered,
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
