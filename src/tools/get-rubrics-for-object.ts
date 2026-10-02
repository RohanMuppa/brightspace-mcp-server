/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Adapted from @el2060's fork (el2060/brightspace-mcp-server, MIT) —
// permission handling rewritten to this project's ApiError/sanitizeError
// conventions and courseId naming.
//
// This is deliberately a separate, simpler tool from get_assignment_rubric:
// that one is student-facing (criteria groups + the caller's own graded
// outcome, resolved against the live /dropbox/folders/{id} + myFeedback
// routes). This one is the instructor/TA-side raw rubric table — every
// rubric attached to a folder, with no per-student outcome — matching the
// shape get_dropbox_folders already surfaces rubric names from.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, ApiError, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetRubricsForObjectSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

interface D2LRubricLevel {
  LevelId: number;
  Name: string;
  Points: number;
  Description: { Text: string; Html: string } | null;
}

interface D2LRubricCriterion {
  CriterionId: number;
  Name: string;
  Levels: D2LRubricLevel[];
}

interface D2LRubricFull {
  RubricId: number;
  Name: string;
  Criteria: D2LRubricCriterion[];
}

interface D2LDropboxFolder {
  Id: number;
  Name: string;
  Assessment: {
    ScoreDenominator: number | null;
    Rubrics: D2LRubricFull[] | null;
  } | null;
}

/**
 * Register get_rubrics_for_object tool.
 */
export function registerGetRubricsForObject(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_rubrics_for_object",
    {
      title: "Get Rubrics for Dropbox Folder",
      description:
        "Retrieve the full rubric table (criteria, levels, and point values) attached to a dropbox " +
        "folder, for an instructor or TA. Use get_dropbox_folders first to find folderId. Like " +
        "get_dropbox_folders, this reads the folder listing's embedded rubric data, so it is not " +
        "gated to instructor/TA accounts the way get_dropbox_submissions and get_dropbox_feedback are.",
      inputSchema: GetRubricsForObjectSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_rubrics_for_object tool called", { args });

        const { courseId, folderId } = GetRubricsForObjectSchema.parse(args);

        const apiPath = apiClient.le(courseId, "/dropbox/folders/");

        let rawFolders: D2LDropboxFolder[];
        try {
          const response = await apiClient.get<
            { Objects: D2LDropboxFolder[] } | D2LDropboxFolder[]
          >(apiPath, { ttl: DEFAULT_CACHE_TTLS.assignments });

          rawFolders = Array.isArray(response) ? response : response.Objects ?? [];
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            return errorResponse(
              "Instructor or TA access required for this course. This tool reads dropbox rubric " +
              "metadata, which Brightspace only grants to course staff."
            );
          }
          if (error instanceof ApiError && error.status === 404) {
            return toolResponse({
              courseId,
              folderId,
              folderName: null,
              rubrics: [],
              note: `Course ${courseId} was not found.`,
            });
          }
          throw error;
        }

        const folder = rawFolders.find((f) => f.Id === folderId);
        if (!folder) {
          return toolResponse({
            courseId,
            folderId,
            folderName: null,
            rubrics: [],
            note: `Dropbox folder ${folderId} not found in course ${courseId}.`,
          });
        }

        const rubrics = folder.Assessment?.Rubrics;
        if (!rubrics || rubrics.length === 0) {
          return toolResponse({
            courseId,
            folderId,
            folderName: folder.Name,
            rubrics: [],
            note: "No rubrics are attached to this dropbox folder.",
          });
        }

        const formattedRubrics = rubrics.map((r) => ({
          rubricId: r.RubricId,
          name: r.Name,
          criteria: (r.Criteria ?? []).map((c) => ({
            criterionId: c.CriterionId,
            name: c.Name,
            levels: (c.Levels ?? []).map((l) => ({
              levelId: l.LevelId,
              name: l.Name,
              points: l.Points,
              description: l.Description?.Text ?? null,
            })),
          })),
        }));

        log(
          "INFO",
          `get_rubrics_for_object: ${formattedRubrics.length} rubric(s) for folder ${folderId}`
        );

        return toolResponse({
          courseId,
          folderId,
          folderName: folder.Name,
          maxScore: folder.Assessment?.ScoreDenominator ?? null,
          rubrics: formattedRubrics,
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
