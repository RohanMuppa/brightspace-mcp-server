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
import { GetDropboxFoldersSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

// D2L Dropbox folder API types
interface D2LDropboxFolder {
  Id: number;
  CategoryId: number | null;
  Name: string;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsHidden: boolean;
  GroupTypeId: number | null;
  SubmissionType: number | null;
  Assessment: {
    ScoreDenominator: number | null;
    Rubrics: Array<{ RubricId: number; Name: string }> | null;
  } | null;
}

/** Map SubmissionType integer to a readable label. */
function submissionTypeLabel(t: number | null): string {
  switch (t) {
    case 0: return "file";
    case 1: return "text";
    case 2: return "on_paper";
    case 3: return "observed_in_person";
    default: return "unknown";
  }
}

/**
 * Register get_dropbox_folders tool.
 */
export function registerGetDropboxFolders(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_dropbox_folders",
    {
      title: "Get Dropbox Folders",
      description:
        "List all assignment/dropbox folders for a course, for an instructor or TA. Returns folder ID, " +
        "name, due date, start/end dates, submission type, visibility, and whether rubrics are attached. " +
        "Use this to discover folderId values before calling get_dropbox_submissions, " +
        "get_dropbox_user_submissions, get_dropbox_feedback, or get_rubrics_for_object. " +
        "This reads the same folder listing a student's own client uses, so it is not gated to " +
        "instructor/TA accounts the way get_dropbox_submissions, get_dropbox_feedback, and " +
        "download_dropbox_submission_file are.",
      inputSchema: GetDropboxFoldersSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_dropbox_folders tool called", { args });

        const { courseId } = GetDropboxFoldersSchema.parse(args);

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
              "Instructor or TA access required for this course. This tool reads every student's " +
              "dropbox folder metadata, which Brightspace only grants to course staff."
            );
          }
          if (error instanceof ApiError && error.status === 404) {
            return toolResponse({
              courseId,
              folders: [],
              note: "No dropbox folders found for this course.",
            });
          }
          throw error;
        }

        const folders = rawFolders.map((f) => ({
          folderId: f.Id,
          name: f.Name,
          categoryId: f.CategoryId,
          isHidden: f.IsHidden,
          isGroup: f.GroupTypeId !== null,
          submissionType: submissionTypeLabel(f.SubmissionType),
          dueDate: f.DueDate ?? null,
          startDate: f.StartDate ?? null,
          endDate: f.EndDate ?? null,
          maxScore: f.Assessment?.ScoreDenominator ?? null,
          rubrics: f.Assessment?.Rubrics?.map((r) => ({
            rubricId: r.RubricId,
            name: r.Name,
          })) ?? [],
          hasRubrics: (f.Assessment?.Rubrics?.length ?? 0) > 0,
        }));

        log("INFO", `get_dropbox_folders: ${folders.length} folders for course ${courseId}`);
        return toolResponse({
          courseId,
          folders,
          ...(folders.length === 0 ? { note: "No dropbox folders found for this course." } : {}),
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
