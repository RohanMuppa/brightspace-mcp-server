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
import { toolResponse, toolResponseWithNotice, sanitizeError, errorResponse } from "./tool-helpers.js";
import { feedbackText } from "../utils/feedback.js";
import { log } from "../utils/logger.js";

// Two rubric shapes are read, as in get-assignment-rubric.ts:
//  - The documented one (Valence Rubric.Rubric): `CriteriaGroups`, each
//    owning a shared `Levels` column list, with one `Cells` entry per level
//    on each criterion (`Id`, and `LevelId`/`Points`/`Description` per cell).
//  - A flattened one: `Criteria` directly on the rubric, each criterion
//    listing its own `Levels` with name, points and description.
// **Why:** only the flattened shape was read, so a tenant sending the
// documented one got every rubric back with `criteria: []` (#458).

interface RichText {
  Text?: string | null;
  Html?: string | null;
}

interface D2LRubricLevel {
  Id?: number;
  LevelId?: number;
  Name: string;
  Points?: number | null;
  Description?: RichText | null;
}

interface D2LRubricCell {
  LevelId?: number;
  Points?: number | null;
  Description?: RichText | null;
}

interface D2LRubricCriterion {
  Id?: number;
  CriterionId?: number;
  Name: string;
  Cells?: D2LRubricCell[] | null;
  Levels?: D2LRubricLevel[] | null;
}

interface D2LRubricCriteriaGroup {
  Name?: string | null;
  Levels?: D2LRubricLevel[] | null;
  Criteria?: D2LRubricCriterion[] | null;
}

interface D2LRubricFull {
  RubricId: number;
  Name: string;
  CriteriaGroups?: D2LRubricCriteriaGroup[] | null;
  Criteria?: D2LRubricCriterion[] | null;
}

interface OutputLevel {
  levelId: number | null;
  name: string | null;
  points: number | null;
  description: string | null;
}

interface OutputCriterion {
  criterionId: number | null;
  name: string;
  group?: string;
  levels: OutputLevel[];
}

/** A level's id, whichever field the tenant put it in. */
function levelIdOf(level: { Id?: number; LevelId?: number }): number | null {
  const id = level.LevelId ?? level.Id;
  return typeof id === "number" ? id : null;
}

/** One criterion's levels, joining Cells to the group's Levels or reading them flat. */
function levelsOf(group: D2LRubricCriteriaGroup, criterion: D2LRubricCriterion): OutputLevel[] {
  if (criterion.Cells?.length) {
    const groupLevels = group.Levels ?? [];
    const byId = new Map(groupLevels.map((l) => [levelIdOf(l), l]));
    return criterion.Cells.map((cell, i) => {
      // A cell names its level by LevelId; without one, cells follow the
      // group's level columns in order.
      const level = cell.LevelId !== undefined ? byId.get(cell.LevelId) : groupLevels[i];
      return {
        levelId: cell.LevelId ?? (level ? levelIdOf(level) : null),
        name: level?.Name ?? null,
        points: cell.Points ?? level?.Points ?? null,
        description: feedbackText(cell.Description),
      };
    });
  }
  return (criterion.Levels ?? []).map((l) => ({
    levelId: levelIdOf(l),
    name: l.Name,
    points: l.Points ?? null,
    description: feedbackText(l.Description),
  }));
}

/** Every criterion of a rubric, across both shapes; null when it carries neither. */
function criteriaOf(rubric: D2LRubricFull): OutputCriterion[] | null {
  const groups: D2LRubricCriteriaGroup[] | null = rubric.CriteriaGroups?.length
    ? rubric.CriteriaGroups
    : rubric.Criteria?.length
      ? [{ Criteria: rubric.Criteria }]
      : null;
  if (!groups) return null;
  return groups.flatMap((group) =>
    (group.Criteria ?? []).map((c) => {
      const id = c.Id ?? c.CriterionId;
      return {
        criterionId: typeof id === "number" ? id : null,
        name: c.Name,
        ...(group.Name ? { group: group.Name } : {}),
        levels: levelsOf(group, c),
      };
    })
  );
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
      annotations: { readOnlyHint: true },
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
              "Brightspace refused to list this course's assignment folders (403). Students can " +
              "normally read this list, so the likely causes are that you are not enrolled in this " +
              "course (check the courseId with get_my_courses) or that the course hides its " +
              "Assignments tool from your role. Check the course in Brightspace.", "permission"
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

        const formattedRubrics = rubrics.map((r) => {
          const criteria = criteriaOf(r);
          return {
            rubricId: r.RubricId,
            name: r.Name,
            criteria: criteria ?? [],
            ...(criteria === null ? { criteriaUnavailable: true } : {}),
          };
        });

        log(
          "INFO",
          `get_rubrics_for_object: ${formattedRubrics.length} rubric(s) for folder ${folderId}`
        );

        const response = {
          courseId,
          folderId,
          folderName: folder.Name,
          maxScore: folder.Assessment?.ScoreDenominator ?? null,
          rubrics: formattedRubrics,
        };
        const unread = formattedRubrics.filter((r) => r.criteriaUnavailable);
        if (unread.length > 0) {
          return toolResponseWithNotice(
            response,
            `The folder listing named ${unread.length} rubric(s) (${unread.map((r) => `"${r.name}"`).join(", ")}) ` +
              "without their criteria, so they have criteria [] and criteriaUnavailable true. Do not tell " +
              "the user these rubrics have no criteria: call get_assignment_rubric for this folder, or " +
              "open the assignment in Brightspace."
          );
        }
        return toolResponse(response);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
