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
import { GetDropboxFeedbackSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { log } from "../utils/logger.js";

interface D2LRubricCriterionCell {
  CriterionId: number;
  LevelId: number | null;
  Points: number | null;
  Comments: { Text: string; Html: string } | null;
}

interface D2LRubricAssessment {
  RubricId: number;
  Name: string;
  TotalPoints: number | null;
  Criteria: D2LRubricCriterionCell[];
}

interface D2LFeedback {
  Score: number | null;
  Feedback: { Text: string; Html: string } | null;
  IsGraded: boolean;
  RubricAssessments: D2LRubricAssessment[] | null;
}

/**
 * Register get_dropbox_feedback tool.
 */
export function registerGetDropboxFeedback(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_dropbox_feedback",
    {
      title: "Get Dropbox Feedback",
      description:
        "Retrieve the existing feedback already saved for a specific user or group in a dropbox folder, " +
        "for an instructor or TA — score, graded state, feedback text, and rubric assessment detail. " +
        "Use this before drafting new feedback to see what has already been recorded. Requires " +
        "instructor or TA access to the course.",
      inputSchema: GetDropboxFeedbackSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_dropbox_feedback tool called", { args });

        const { courseId, folderId, entityType, entityId } = GetDropboxFeedbackSchema.parse(args);

        const feedbackPath = apiClient.le(
          courseId,
          `/dropbox/folders/${folderId}/feedback/${entityType}/${entityId}`
        );

        let feedback: D2LFeedback;
        try {
          feedback = await apiClient.get<D2LFeedback>(feedbackPath);
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            return errorResponse(
              "Instructor or TA access required for this course. This tool reads another user's " +
              "grading feedback, which Brightspace only grants to course staff."
            );
          }
          if (error instanceof ApiError && error.status === 404) {
            return toolResponse({
              courseId,
              folderId,
              entityType,
              entityId,
              feedback: null,
              note: "No feedback found. This submission has not been graded yet.",
            });
          }
          throw error;
        }

        const feedbackMarkdown = feedback.Feedback?.Html
          ? convertHtmlToMarkdown(feedback.Feedback.Html).markdown
          : null;

        const rubricAssessments = feedback.RubricAssessments?.map((ra) => ({
          rubricId: ra.RubricId,
          rubricName: ra.Name,
          totalPoints: ra.TotalPoints,
          // Adapted from get-rubrics-for-object.ts's defensive ?? [] — some
          // tenants return a null Criteria array on an unscored assessment.
          criteria: (ra.Criteria ?? []).map((c) => ({
            criterionId: c.CriterionId,
            selectedLevelId: c.LevelId,
            points: c.Points,
            comments: c.Comments?.Text ?? null,
          })),
        })) ?? [];

        log(
          "INFO",
          `get_dropbox_feedback: retrieved feedback for ${entityType} ${entityId} in folder ${folderId}`
        );

        return toolResponse({
          courseId,
          folderId,
          entityType,
          entityId,
          feedback: {
            score: feedback.Score,
            isGraded: feedback.IsGraded,
            feedbackText: feedback.Feedback?.Text ?? null,
            feedbackMarkdown,
            rubricAssessments,
          },
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
