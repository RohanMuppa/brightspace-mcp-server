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
import { fetchCurrentUserId } from "./group-membership.js";

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
      annotations: { readOnlyHint: true },
      description:
        "Retrieve the feedback saved for a dropbox folder — score, graded state, feedback text, and rubric " +
        "assessment detail. Students: omit entityType and entityId to read your OWN released feedback on an " +
        "assignment (it is not hidden; use this when get_assignments shows feedback unavailable). " +
        "Instructors and TAs: pass entityType and entityId to read what is already saved for any user or " +
        "group, e.g. before drafting new feedback; reading another user's feedback requires instructor or TA " +
        "access to the course.",
      inputSchema: GetDropboxFeedbackSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_dropbox_feedback tool called", { args });

        const parsed = GetDropboxFeedbackSchema.parse(args);
        const { courseId, folderId } = parsed;

        // Omitted entity = the signed-in user's own feedback, which Brightspace
        // lets a student read once it is released.
        const own = parsed.entityId === undefined;
        if (own && parsed.entityType === "group") {
          return errorResponse("entityId is required when entityType is group.", "validation");
        }
        const entityType = parsed.entityType ?? "user";
        const entityId = parsed.entityId ?? await fetchCurrentUserId(apiClient);

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
              own
                ? "Brightspace refused this read of your own feedback; it has not been released yet, or " +
                  "this course does not expose it through the API. Check the assignment in Brightspace."
                : "Instructor or TA access required for this course. Reading another user's grading " +
                  "feedback is only granted to course staff; to read your own, omit entityType and entityId.",
              "permissionDenied"
            );
          }
          if (error instanceof ApiError && error.status === 404) {
            return toolResponse({
              courseId,
              folderId,
              entityType,
              entityId,
              feedback: null,
              note: own
                ? "No feedback found. This submission has not been graded yet, or its feedback has not been released."
                : "No feedback found. This submission has not been graded yet.",
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
