/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, ApiError, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetAssignmentRubricSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { log } from "../utils/logger.js";

// D2L rubric API types. Two shapes are read because tenants disagree on
// where a level's own name, points, and description live:
//  - The documented analytic-rubric shape: a criteria group owns a shared
//    `Levels` column list, and each criterion carries one `Cell` per level
//    (LevelId + its own Points/Description for that criterion x level pair).
//  - A flattened shape some responses use instead: each criterion lists its
//    own `Levels` directly, already carrying name/points/description with no
//    group-level sharing or cell indirection.
// Both are normalized into the same output table below.

interface RichText {
  Text?: string | null;
  Html?: string | null;
}

interface RubricGroupLevelDto {
  Id: number;
  Name: string;
  Points?: number | null;
}

interface RubricCellDto {
  LevelId: number;
  Description?: RichText | null;
  Points?: number | null;
}

interface RubricFlatLevelDto {
  Id?: number;
  LevelId?: number;
  Name: string;
  Points?: number | null;
  Description?: RichText | null;
}

interface RubricCriterionDto {
  Id: number;
  Name: string;
  Cells?: RubricCellDto[];
  Levels?: RubricFlatLevelDto[];
}

interface RubricCriteriaGroupDto {
  Name?: string;
  Levels?: RubricGroupLevelDto[];
  Criteria?: RubricCriterionDto[];
}

interface RubricDto {
  RubricId: number;
  Name: string;
  Description?: RichText | null;
  ScoringMethod?: number;
  CriteriaGroups?: RubricCriteriaGroupDto[];
  // Some tenants omit the group wrapper entirely and put Criteria directly
  // on the rubric; get-assignments.ts's own embedded-rubric parsing assumes
  // this shape, so it is read here too.
  Criteria?: RubricCriterionDto[];
}

interface DropboxFolderDto {
  Id: number;
  Assessment?: { Rubrics?: RubricDto[] } | null;
}

interface RubricAssessmentOutcomeDto {
  CriterionId: number;
  LevelId?: number | null;
  Score?: number | null;
  Feedback?: RichText | null;
}

interface RubricAssessmentDto {
  RubricId: number;
  // The documented Dropbox myFeedback shape (D2L's "RubricAssessment" block)
  // carries the overall outcome as three flat fields rather than a nested
  // object, and may omit CriteriaOutcome entirely. OverallOutcome itself is
  // a shape seen from a different endpoint; both are accepted.
  OverallOutcome?: {
    LevelId?: number | null;
    Score?: number | null;
    Feedback?: RichText | null;
  } | null;
  OverallScore?: number | null;
  OverallLevel?: number | null;
  OverallFeedback?: RichText | null;
  CriteriaOutcome?: RubricAssessmentOutcomeDto[];
}

// Reuses the same `myFeedback` route get-assignments.ts already calls
// (DropboxFeedback.RubricAssessments there is typed `any[]`); this is the
// one place that shape is actually read.
interface DropboxFeedbackDto {
  RubricAssessments?: RubricAssessmentDto[];
}

// Output shapes -----------------------------------------------------------

interface OutputLevel {
  name: string;
  points?: number;
  description?: string;
}

interface OutputCriterion {
  name: string;
  levels: OutputLevel[];
}

interface OutputGroup {
  name: string;
  criteria: OutputCriterion[];
}

interface OutputCriterionOutcome {
  criterionName: string;
  levelName?: string;
  score?: number;
  feedback?: string;
}

interface OutputAssessment {
  levelName?: string;
  score?: number;
  feedback?: string;
  criteria: OutputCriterionOutcome[];
}

interface OutputRubric {
  rubricId: number;
  name: string;
  description?: string;
  scoringMethod?: number;
  scoringMethodName?: string;
  criteriaGroups: OutputGroup[];
  totalPoints?: number;
  rubricAssessment?: OutputAssessment;
}

// D2L's documented SCORING_M enumeration
// (https://docs.valence.desire2learn.com/res/assessment.html). Only values
// that source confirms are named; an unrecognized value is left as the raw
// number with no scoringMethodName.
const SCORING_METHOD_NAMES: Record<number, string> = {
  0: "TextOnly",
  1: "Points",
  2: "TextAndNumeric",
  3: "CustomPoints",
};

export interface GetAssignmentRubricResult {
  rubrics: OutputRubric[];
  note?: string;
}

/** Rich text to plain markdown, or undefined when there is nothing to say. */
function textOf(rt?: RichText | null): string | undefined {
  if (!rt) return undefined;
  const text = rt.Html ? convertHtmlToMarkdown(rt.Html).markdown : rt.Text ?? undefined;
  return text && text.trim().length > 0 ? text : undefined;
}

/** The groups a rubric carries, normalizing the grouped and flattened shapes. */
function groupsOf(rubric: RubricDto): RubricCriteriaGroupDto[] {
  if (rubric.CriteriaGroups?.length) return rubric.CriteriaGroups;
  if (rubric.Criteria?.length) return [{ Criteria: rubric.Criteria }];
  return [];
}

/** A criterion's levels, joining the Cells/Levels split or reading them flat. */
function levelsOfCriterion(
  group: RubricCriteriaGroupDto,
  criterion: RubricCriterionDto
): OutputLevel[] {
  if (criterion.Cells?.length) {
    const groupLevels = new Map((group.Levels ?? []).map((l) => [l.Id, l]));
    return criterion.Cells.map((cell) => {
      const groupLevel = groupLevels.get(cell.LevelId);
      const points = cell.Points ?? groupLevel?.Points ?? undefined;
      const out: OutputLevel = { name: groupLevel?.Name ?? `Level ${cell.LevelId}` };
      if (points !== null && points !== undefined) out.points = points;
      const description = textOf(cell.Description);
      if (description) out.description = description;
      return out;
    });
  }

  return (criterion.Levels ?? []).map((level) => {
    const out: OutputLevel = { name: level.Name };
    if (level.Points !== null && level.Points !== undefined) out.points = level.Points;
    const description = textOf(level.Description);
    if (description) out.description = description;
    return out;
  });
}

function criteriaGroupsOf(rubric: RubricDto): OutputGroup[] {
  return groupsOf(rubric).map((group) => ({
    name: group.Name ?? "",
    criteria: (group.Criteria ?? []).map((criterion) => ({
      name: criterion.Name,
      levels: levelsOfCriterion(group, criterion),
    })),
  }));
}

/**
 * Sum of each criterion's best achievable points. A criterion with no
 * numeric level (a text-only rubric) contributes nothing; the whole field is
 * left off the response only when every criterion is like that.
 */
function totalPointsOf(groups: OutputGroup[]): number | undefined {
  let total: number | undefined;
  for (const group of groups) {
    for (const criterion of group.criteria) {
      const points = criterion.levels
        .map((l) => l.points)
        .filter((p): p is number => typeof p === "number");
      if (points.length === 0) continue;
      total = (total ?? 0) + Math.max(...points);
    }
  }
  return total;
}

/** Criterion id -> name, across either rubric shape. */
function criterionNamesOf(rubric: RubricDto): Map<number, string> {
  const map = new Map<number, string>();
  for (const group of groupsOf(rubric)) {
    for (const criterion of group.Criteria ?? []) {
      if (typeof criterion.Id === "number") map.set(criterion.Id, criterion.Name);
    }
  }
  return map;
}

/** Level id -> name, across either rubric shape. */
function levelNamesOf(rubric: RubricDto): Map<number, string> {
  const map = new Map<number, string>();
  for (const group of rubric.CriteriaGroups ?? []) {
    for (const level of group.Levels ?? []) {
      if (typeof level.Id === "number") map.set(level.Id, level.Name);
    }
  }
  for (const criterion of rubric.Criteria ?? []) {
    for (const level of criterion.Levels ?? []) {
      const id = level.Id ?? level.LevelId;
      if (typeof id === "number") map.set(id, level.Name);
    }
  }
  return map;
}

/**
 * The student's own graded outcome on this rubric, resolved against the
 * rubric's own criterion/level names rather than re-sent by the assessment.
 */
function toOutputAssessment(
  rubric: RubricDto,
  assessment: RubricAssessmentDto
): OutputAssessment {
  const criterionNames = criterionNamesOf(rubric);
  const levelNames = levelNamesOf(rubric);

  const out: OutputAssessment = { criteria: [] };

  // Documented Dropbox RubricAssessment carries OverallScore/OverallLevel/
  // OverallFeedback instead of a nested OverallOutcome; fall back to those
  // when OverallOutcome itself is absent.
  const overall = assessment.OverallOutcome ?? {
    Score: assessment.OverallScore,
    LevelId: assessment.OverallLevel,
    Feedback: assessment.OverallFeedback,
  };
  if (overall) {
    if (typeof overall.Score === "number") out.score = overall.Score;
    const levelName = overall.LevelId != null ? levelNames.get(overall.LevelId) : undefined;
    if (levelName) out.levelName = levelName;
    const feedback = textOf(overall.Feedback);
    if (feedback) out.feedback = feedback;
  }

  out.criteria = (assessment.CriteriaOutcome ?? []).map((outcome) => {
    const entry: OutputCriterionOutcome = {
      criterionName: criterionNames.get(outcome.CriterionId) ?? `Criterion ${outcome.CriterionId}`,
    };
    const levelName = outcome.LevelId != null ? levelNames.get(outcome.LevelId) : undefined;
    if (levelName) entry.levelName = levelName;
    if (typeof outcome.Score === "number") entry.score = outcome.Score;
    const feedback = textOf(outcome.Feedback);
    if (feedback) entry.feedback = feedback;
    return entry;
  });

  return out;
}

function toOutputRubric(rubric: RubricDto, assessment?: RubricAssessmentDto): OutputRubric {
  const criteriaGroups = criteriaGroupsOf(rubric);

  const out: OutputRubric = {
    rubricId: rubric.RubricId,
    name: rubric.Name,
    criteriaGroups,
  };

  const description = textOf(rubric.Description);
  if (description) out.description = description;
  if (typeof rubric.ScoringMethod === "number") {
    out.scoringMethod = rubric.ScoringMethod;
    const name = SCORING_METHOD_NAMES[rubric.ScoringMethod];
    if (name) out.scoringMethodName = name;
  }

  const totalPoints = totalPointsOf(criteriaGroups);
  if (totalPoints !== undefined) out.totalPoints = totalPoints;

  if (assessment) out.rubricAssessment = toOutputAssessment(rubric, assessment);

  return out;
}

/**
 * Fetch every rubric attached to a dropbox assignment, with the student's own
 * graded outcome merged in where it is available.
 *
 * Rubrics normally ride along embedded in the folder's own
 * `Assessment.Rubrics`; a tenant/version that omits them there is asked
 * directly via the rubrics listing endpoint. The student's outcome comes from
 * `myFeedback`'s `RubricAssessments` — the same route get-assignments.ts
 * already calls for grade/feedback — never from the unstable rubric
 * assessment route, which this tool does not call.
 */
export async function fetchAssignmentRubrics(
  apiClient: D2LApiClient,
  courseId: number,
  assignmentId: number
): Promise<GetAssignmentRubricResult> {
  let folder: DropboxFolderDto;
  try {
    folder = await apiClient.get<DropboxFolderDto>(
      apiClient.le(courseId, `/dropbox/folders/${assignmentId}`),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      return {
        rubrics: [],
        note: "You do not have permission to view this assignment.",
      };
    }
    if (error instanceof ApiError && error.status === 404) {
      return {
        rubrics: [],
        note: "This assignment was not found. It may not exist or may have been removed.",
      };
    }
    throw error;
  }

  let rubrics: RubricDto[] = folder.Assessment?.Rubrics ?? [];

  if (rubrics.length === 0) {
    try {
      const raw = await apiClient.get<{ Objects: RubricDto[] } | RubricDto[]>(
        apiClient.le(courseId, `/rubrics?objectType=Dropbox&objectId=${assignmentId}`),
        { ttl: DEFAULT_CACHE_TTLS.assignments }
      );
      rubrics = Array.isArray(raw) ? raw : raw?.Objects ?? [];
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        rubrics = [];
      } else {
        log("DEBUG", `Failed to fetch rubrics for assignment ${assignmentId} via the rubrics endpoint`, error);
        rubrics = [];
      }
    }
  }

  if (rubrics.length === 0) {
    return { rubrics: [], note: "This assignment has no rubric attached." };
  }

  // Best-effort: the student's outcome is a bonus, not a requirement for the
  // rubric table itself, and a course that hides feedback should not turn
  // "here's how it's graded" into an error.
  const assessmentsByRubricId = new Map<number, RubricAssessmentDto>();
  try {
    const feedback = await apiClient.get<DropboxFeedbackDto>(
      apiClient.le(courseId, `/dropbox/folders/${assignmentId}/feedback/myFeedback/`),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    );
    for (const assessment of feedback?.RubricAssessments ?? []) {
      if (typeof assessment?.RubricId === "number") {
        assessmentsByRubricId.set(assessment.RubricId, assessment);
      }
    }
  } catch (error) {
    if (!(error instanceof ApiError && (error.status === 403 || error.status === 404))) {
      log("DEBUG", `Failed to fetch rubric assessment feedback for assignment ${assignmentId}`, error);
      throw error;
    }
  }

  return {
    rubrics: rubrics.map((r) => toOutputRubric(r, assessmentsByRubricId.get(r.RubricId))),
  };
}

/**
 * Register get_assignment_rubric tool
 */
export function registerGetAssignmentRubric(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_assignment_rubric",
    {
      title: "Get Assignment Rubric",
      description:
        "Fetch the full grading rubric for a dropbox assignment: every criteria group, criterion, and achievement level with its points and description, plus the student's own graded outcome per criterion once it has been released. Use this when the user asks what a rubric wants, how an assignment will be graded, or why they got a particular score on a criterion.",
      inputSchema: GetAssignmentRubricSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_assignment_rubric tool called", { args });

        const { courseId, assignmentId } = GetAssignmentRubricSchema.parse(args);

        const result = await fetchAssignmentRubrics(apiClient, courseId, assignmentId);

        log(
          "INFO",
          `get_assignment_rubric: Retrieved ${result.rubrics.length} rubric(s) for assignment ${assignmentId} in course ${courseId}`
        );
        return toolResponse({ courseId, assignmentId, ...result });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
