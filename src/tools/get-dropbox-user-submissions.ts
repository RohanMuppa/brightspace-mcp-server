/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Adapted from @el2060's fork (el2060/brightspace-mcp-server, MIT) —
// permission handling rewritten to this project's ApiError/sanitizeError
// conventions and courseId naming.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, ApiError } from "../api/index.js";
import { GetDropboxUserSubmissionsSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

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

/**
 * Register get_dropbox_user_submissions tool.
 */
export function registerGetDropboxUserSubmissions(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_dropbox_user_submissions",
    {
      title: "Get Dropbox User Submissions",
      description:
        "Retrieve all submissions made by one specific student (or group) in a dropbox folder, for an " +
        "instructor or TA — useful for reviewing a single student's work before drafting feedback. " +
        "Use get_dropbox_submissions or get_roster to find the userId first. Requires instructor or TA " +
        "access to the course.",
      inputSchema: GetDropboxUserSubmissionsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_dropbox_user_submissions tool called", { args });

        const { courseId, folderId, userId, ignoreFeedback } =
          GetDropboxUserSubmissionsSchema.parse(args);

        const submissionsPath = apiClient.le(
          courseId,
          `/dropbox/folders/${folderId}/submissions/users/${userId}`
        );

        let rawSubmissions: D2LSubmission[];
        try {
          const raw = await apiClient.get<{ Objects: D2LSubmission[] } | D2LSubmission[]>(
            submissionsPath
          );
          rawSubmissions = Array.isArray(raw) ? raw : raw.Objects ?? [];
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            return errorResponse(
              "Instructor or TA access required for this course. This tool reads another user's " +
              "dropbox submissions, which Brightspace only grants to course staff."
            );
          }
          if (error instanceof ApiError && error.status === 404) {
            return toolResponse({
              courseId,
              folderId,
              userId,
              submissions: [],
              note: `No submissions found for user ${userId} in dropbox folder ${folderId}. ` +
                "The user may not have submitted, or the folder may not exist.",
            });
          }
          throw error;
        }

        if (rawSubmissions.length === 0) {
          return toolResponse({
            courseId,
            folderId,
            userId,
            submissions: [],
            note: "No submissions found for this user in the specified folder.",
          });
        }

        let feedback: D2LFeedback | null = null;
        if (!ignoreFeedback) {
          try {
            const feedbackPath = apiClient.le(
              courseId,
              `/dropbox/folders/${folderId}/feedback/user/${userId}`
            );
            feedback = await apiClient.get<D2LFeedback>(feedbackPath);
          } catch {
            // No feedback yet — silently skip, matching the "not graded yet" default below.
          }
        }

        const submissions = rawSubmissions.map((sub) => ({
          submissionId: sub.Id,
          userId: sub.SubmittedBy.Identifier,
          displayName: sub.SubmittedBy.DisplayName,
          submittedDate: sub.SubmissionDate,
          files: sub.Files.map((f) => ({
            fileId: f.FileId,
            name: f.FileName,
            size: f.Size,
          })),
          comment: sub.Comment?.Text ?? null,
        }));

        const feedbackStatus = ignoreFeedback
          ? undefined
          : feedback
          ? {
              isGraded: feedback.IsGraded,
              score: feedback.Score,
              hasFeedbackText: !!feedback.Feedback?.Text,
              feedbackText: feedback.Feedback?.Text ?? null,
            }
          : { isGraded: false, score: null, hasFeedbackText: false, feedbackText: null };

        log(
          "INFO",
          `get_dropbox_user_submissions: ${submissions.length} submissions for user ${userId} in folder ${folderId}`
        );

        return toolResponse({
          courseId,
          folderId,
          userId,
          submissions,
          feedbackStatus,
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
