/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetAssignmentsSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { log } from "../utils/logger.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { assignmentUrl, gradebookUrl, quizUrl } from "../utils/deep-links.js";
import type { AppConfig } from "../types/index.js";

// D2L Dropbox API types
interface DropboxFolder {
  Id: number;
  CategoryId: number | null;
  Name: string;
  CustomInstructions: { Text: string; Html: string } | null;
  DueDate: string | null;
  IsHidden: boolean;
  Assessment: {
    ScoreDenominator: number | null;
    Rubrics: Array<{
      RubricId: number;
      Name: string;
      Criteria: Array<{
        CriterionId: number;
        Name: string;
        Levels: Array<{
          LevelId: number;
          Name: string;
          Points: number;
          Description: { Text: string; Html: string } | null;
        }>;
      }>;
    }>;
  } | null;
  GroupTypeId: number | null; // null = individual, non-null = group
  SubmissionType: number | null;
}

interface DropboxSubmission {
  Id: number;
  SubmittedBy: { Identifier: string; DisplayName: string };
  SubmissionDate: string;
  Comment: { Text: string; Html: string } | null;
  Files: Array<{ FileId: number; FileName: string; Size: number }>;
}

interface DropboxFeedback {
  Score: number | null;
  Feedback: { Text: string; Html: string } | null;
  RubricAssessments: any[];
}

// D2L Quiz API types
/**
 * Quiz rich text as the live tenant sends it: the display string is nested a
 * level deeper, under Text.Html. Older responses put Html at the top level, so
 * both are declared and richTextHtml reads whichever is present.
 */
interface QuizRichText {
  Text?: { Text?: string | null; Html?: string | null } | string | null;
  Html?: string | null;
  IsDisplayed?: boolean;
}

interface QuizTimeLimit {
  IsEnforced: boolean;
  ShowClock: boolean;
  TimeLimitValue: number; // minutes
}

interface QuizReadData {
  QuizId: number;
  Name: string;
  Description: QuizRichText | null;
  Instructions?: QuizRichText | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsActive: boolean;
  AttemptsAllowed: {
    IsUnlimited: boolean;
    NumberOfAttemptsAllowed: number | null;
  } | null;
  // The live field name. TimeLimit is the older flat spelling, kept so a
  // tenant that still sends it keeps working.
  SubmissionTimeLimit?: QuizTimeLimit | null;
  TimeLimit?: QuizTimeLimit | null;
  SubmissionGracePeriod?: number | null;
  Password?: string | null;
}

/** The display HTML of a quiz rich-text field, nested shape or flat. */
function richTextHtml(field: QuizRichText | null | undefined): string | null {
  if (!field) return null;
  const nested =
    typeof field.Text === "object" && field.Text !== null ? field.Text.Html : null;
  return nested ?? field.Html ?? null;
}

interface QuizAttemptData {
  AttemptId: number;
  AttemptNumber: number;
  Score: number | null;
  IsCompleted: boolean;
  CompletedDate: string | null;
}

interface EnrollmentItem {
  OrgUnit: {
    Id: number;
    Name: string;
    Code: string;
  };
  Access: {
    ClasslistRoleName: string;
    IsActive: boolean;
    CanAccess?: boolean;
    LastAccessed: string | null;
  };
}

interface EnrollmentResponse {
  Items: EnrollmentItem[];
  PagingInfo?: {
    HasMoreItems: boolean;
    Bookmark?: string;
  };
}

// D2L gradebook types
interface GradeObject {
  Id: number;
  Name: string;
  GradeObjectTypeId: number;
  AssociatedTool: { ToolId: number; ToolItemId: number } | null;
}

/**
 * The grade object types a student is actually scored on: 1 numeric,
 * 2 passfail, 3 selectbox, 4 text. The rest (category, calculated, formula,
 * final) are the gradebook's own arithmetic, not work anybody owes.
 */
const STUDENT_SCORED = new Set([1, 2, 3, 4]);

/**
 * Fetch assignments (dropbox + quizzes) for a single course
 *
 * baseUrl is optional: without it the items carry a null url.
 */
export async function fetchCourseAssignments(
  apiClient: D2LApiClient,
  courseId: number,
  baseUrl?: string
): Promise<any[]> {
  const assignments: any[] = [];

  // Fetch dropbox folders, quizzes, and the gradebook in parallel. The
  // gradebook is fetched alongside them but read last: a heads-up row is a
  // column that nothing the other two returned matched, so the comparison
  // cannot be made until they have answered.
  const [dropboxResult, quizResult, gradebookResult] = await Promise.allSettled([
    apiClient.get<{ Objects: DropboxFolder[] } | DropboxFolder[]>(
      apiClient.le(courseId, "/dropbox/folders/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    ),
    apiClient.get<{ Objects: QuizReadData[] } | QuizReadData[]>(
      apiClient.le(courseId, "/quizzes/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    ),
    apiClient.get<GradeObject[]>(apiClient.le(courseId, "/grades/"), {
      ttl: DEFAULT_CACHE_TTLS.assignments,
    }),
  ]);

  // Process Dropbox folders
  if (dropboxResult.status === "fulfilled") {
    // D2L dropbox endpoint may return paged { Objects: [...] } or flat array
    const dropboxRaw = dropboxResult.value;
    const folders: DropboxFolder[] = Array.isArray(dropboxRaw) ? dropboxRaw : (dropboxRaw as any).Objects ?? [];

    for (const folder of folders) {
      // Skip hidden folders
      if (folder.IsHidden) continue;

      // Fetch submissions for this folder
      let submissions: DropboxSubmission[] = [];
      try {
        const submissionsRaw = await apiClient.get<{ Objects: DropboxSubmission[] } | DropboxSubmission[]>(
          apiClient.le(courseId, `/dropbox/folders/${folder.Id}/submissions/mysubmissions/`),
          { ttl: DEFAULT_CACHE_TTLS.assignments }
        );
        submissions = Array.isArray(submissionsRaw) ? submissionsRaw : (submissionsRaw as any).Objects ?? [];
      } catch (error: any) {
        // 404 means no submissions yet - that's fine
        if (error?.status !== 404) {
          log("DEBUG", `Failed to fetch submissions for folder ${folder.Id}`, error);
        }
      }

      // Fetch feedback independently of submissions
      let feedback: DropboxFeedback | null = null;
      try {
        feedback = await apiClient.get<DropboxFeedback>(
          apiClient.le(courseId, `/dropbox/folders/${folder.Id}/feedback/myFeedback/`),
          { ttl: DEFAULT_CACHE_TTLS.assignments }
        );
      } catch (error: any) {
        // 404/403 means no feedback available (or no access) - that's fine
        if (error?.status !== 404 && error?.status !== 403) {
          log("DEBUG", `Failed to fetch feedback for folder ${folder.Id}`, error);
        }
      }

      // Build assignment object
      const assignment = {
        type: "assignment",
        id: folder.Id,
        name: folder.Name,
        url: baseUrl ? assignmentUrl(baseUrl, courseId, folder.Id) : null,
        instructions: folder.CustomInstructions?.Html
          ? convertHtmlToMarkdown(folder.CustomInstructions.Html)
          : { markdown: "", html: "" },
        dueDate: folder.DueDate,
        points: folder.Assessment?.ScoreDenominator ?? null,
        isGroup: folder.GroupTypeId !== null,
        rubric: folder.Assessment?.Rubrics?.map((r) => ({
          name: r.Name,
          criteria: r.Criteria?.map((c) => ({
            name: c.Name,
            levels: c.Levels?.map((l) => ({
              name: l.Name,
              points: l.Points,
              description: l.Description?.Text ?? null,
            })) ?? [],
          })) ?? [],
        })) ?? null,
        submission: submissions.length > 0
          ? {
              submittedDate: submissions[0].SubmissionDate,
              files: submissions[0].Files?.map((f) => ({
                name: f.FileName,
                size: f.Size,
                fileId: f.FileId,
              })) ?? [],
              comment: submissions[0].Comment?.Text ?? null,
            }
          : null,
        feedback: feedback
          ? {
              score: feedback.Score,
              feedback: feedback.Feedback?.Html
                ? convertHtmlToMarkdown(feedback.Feedback.Html)
                : null,
            }
          : null,
      };

      assignments.push(assignment);
    }
  } else {
    // Log dropbox fetch failure but don't throw
    log("DEBUG", `Failed to fetch dropbox folders for course ${courseId}`, dropboxResult.reason);
  }

  // Process Quizzes
  if (quizResult.status === "fulfilled") {
    const quizResponse = quizResult.value;
    // D2L quizzes API returns paged result { Objects: [...] } or a plain array
    const quizzes: QuizReadData[] = Array.isArray(quizResponse)
      ? quizResponse
      : (quizResponse as any)?.Objects ?? [];

    // Students on this tenant get 403 from /quizzes/{id}/attempts/. Once the
    // first quiz of a course proves that, the remaining quizzes are not asked:
    // the answer would be the same 403, at one wasted request each.
    let attemptsForbidden = false;

    for (const quiz of quizzes) {
      // Skip inactive quizzes
      if (!quiz.IsActive) continue;

      // Fetch quiz attempts. null means "not measured", which is different
      // from an empty list, and the output says which one it was.
      let attempts: QuizAttemptData[] | null = null;
      if (!attemptsForbidden) {
        try {
          const attemptsRaw = await apiClient.get<{ Objects: QuizAttemptData[] } | QuizAttemptData[]>(
            apiClient.le(courseId, `/quizzes/${quiz.QuizId}/attempts/`),
            { ttl: DEFAULT_CACHE_TTLS.assignments }
          );
          // D2L attempts endpoint may return paged { Objects: [...] } or flat array
          attempts = Array.isArray(attemptsRaw) ? attemptsRaw : (attemptsRaw as any).Objects ?? [];
        } catch (error: any) {
          if (error?.status === 404) {
            // 404 means no attempts yet, which is a measurement of zero
            attempts = [];
          } else if (error?.status === 403) {
            attemptsForbidden = true;
            log("DEBUG", `Attempts are forbidden for course ${courseId}: not asking again`);
          } else {
            log("DEBUG", `Failed to fetch attempts for quiz ${quiz.QuizId}`, error);
          }
        }
      }

      // Calculate remaining attempts
      const completedAttempts = attempts?.filter((a) => a.IsCompleted) ?? null;
      let attemptsRemaining: number | string | null = null;
      let attemptWarning: string | null = null;

      if (completedAttempts) {
        attemptsRemaining = "Unlimited";

        if (quiz.AttemptsAllowed && !quiz.AttemptsAllowed.IsUnlimited) {
          const allowed = quiz.AttemptsAllowed.NumberOfAttemptsAllowed ?? 0;
          attemptsRemaining = allowed - completedAttempts.length;

          // Generate warning for low attempts
          if (attemptsRemaining <= 0) {
            attemptWarning = "WARNING: No attempts remaining";
          } else if (attemptsRemaining === 1) {
            attemptWarning = "WARNING: Only 1 attempt remaining";
          }
        }
      }

      const timeLimit = quiz.SubmissionTimeLimit ?? quiz.TimeLimit;
      const descriptionHtml = richTextHtml(quiz.Description);

      // Build quiz object
      const quizAssignment = {
        type: "quiz",
        id: quiz.QuizId,
        name: quiz.Name,
        url: baseUrl ? quizUrl(baseUrl, courseId, quiz.QuizId) : null,
        instructions: descriptionHtml
          ? convertHtmlToMarkdown(descriptionHtml)
          : { markdown: "", html: "" },
        dueDate: quiz.DueDate,
        startDate: quiz.StartDate,
        endDate: quiz.EndDate,
        timeLimit: timeLimit?.IsEnforced ? timeLimit.TimeLimitValue : null,
        attemptsAllowed: quiz.AttemptsAllowed?.IsUnlimited
          ? "Unlimited"
          : quiz.AttemptsAllowed?.NumberOfAttemptsAllowed ?? null,
        // False when the tenant refused the attempts endpoint, in which case
        // every count below is null rather than a guess of zero.
        attemptsAvailable: completedAttempts !== null,
        attemptsUsed: completedAttempts?.length ?? null,
        attemptsRemaining,
        attemptWarning,
        bestScore: completedAttempts && completedAttempts.length > 0
          ? Math.max(...completedAttempts.map((a) => a.Score ?? 0))
          : null,
        gracePeriodMinutes: quiz.SubmissionGracePeriod ?? null,
        hasPassword: Boolean(quiz.Password),
      };

      assignments.push(quizAssignment);
    }
  } else {
    // Log quiz fetch failure but don't throw
    log("DEBUG", `Failed to fetch quizzes for course ${courseId}`, quizResult.reason);
  }

  // Process the gradebook last, once the fetched items are known.
  if (gradebookResult.status === "fulfilled") {
    assignments.push(
      ...gradebookHeadsUp(gradebookResult.value, assignments, courseId, baseUrl)
    );
  } else {
    log("DEBUG", `Failed to fetch the gradebook for course ${courseId}`, gradebookResult.reason);
  }

  return assignments;
}

/**
 * Gradebook columns describing work that no other route already offered.
 *
 * Two rules decide what qualifies. The column must be one a student is scored
 * on, which excludes the bookkeeping types that describe the gradebook's own
 * arithmetic. And it must match no already-fetched assignment or quiz: not
 * "unlinked", which would be the wrong test, because a released midterm's
 * column IS linked, to a quiz the student's own quizzes call cannot see, and
 * that column is the entire reason this exists.
 *
 * A column with no id or no name is skipped rather than fatal: one malformed
 * row should cost its own line, not the course's other heads-up rows.
 */
function gradebookHeadsUp(
  raw: unknown,
  fetched: any[],
  courseId: number,
  baseUrl?: string
): any[] {
  if (!Array.isArray(raw)) return [];

  const covered = new Set(
    fetched.map((item) => item.id).filter((id) => typeof id === "number")
  );

  const rows: any[] = [];
  for (const column of raw as GradeObject[]) {
    if (!STUDENT_SCORED.has(column?.GradeObjectTypeId as number)) continue;
    if (covered.has(column.AssociatedTool?.ToolItemId as number)) continue;
    if (typeof column.Id !== "number" || typeof column.Name !== "string") continue;

    rows.push({
      type: "gradeOnly",
      id: column.Id,
      name: column.Name,
      // Always null: a grade column carries no due date of its own, and
      // inventing one from the column name would be a guess.
      dueDate: null,
      url: baseUrl ? gradebookUrl(baseUrl, courseId) : null,
    });
  }
  return rows;
}

/**
 * Register get_assignments tool
 */
export function registerGetAssignments(
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
): void {
  server.registerTool(
    "get_assignments",
    {
      title: "Get Assignments",
      description:
        "Fetch assignments and quizzes for a specific course or all enrolled courses. Shows dropbox submissions and quizzes with due dates, status, and rubric info. Use this when the user asks about assignments, homework, what to submit, quizzes, or assignment details and rubrics.",
      inputSchema: GetAssignmentsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_assignments tool called", { args });

        // Parse and validate input
        const { courseId } = GetAssignmentsSchema.parse(args);

        // Single course case
        if (courseId) {
          const assignments = await fetchCourseAssignments(apiClient, courseId, config.baseUrl);

          log("INFO", `get_assignments: Retrieved ${assignments.length} assignments for course ${courseId}`);
          return toolResponse({ courseId, assignments });
        }

        // All courses case
        // First, fetch enrolled courses
        const enrollmentPath = apiClient.lp(
          "/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true"
        );
        const enrollmentResponse = await apiClient.get<EnrollmentResponse>(
          enrollmentPath,
          { ttl: DEFAULT_CACHE_TTLS.enrollments }
        );

        // Apply course filter
        const filteredEnrollments = applyCourseFilter(
          enrollmentResponse.Items.map(item => ({
            id: item.OrgUnit.Id,
            name: item.OrgUnit.Name,
            code: item.OrgUnit.Code,
            isActive: item.Access.IsActive,
            canAccess: item.Access.CanAccess,
            ...item,
          })),
          config.courseFilter
        );

        // Fetch assignments for each course (handle 403s gracefully)
        const assignmentPromises = filteredEnrollments.map(async (item) => {
          try {
            const assignments = await fetchCourseAssignments(apiClient, item.OrgUnit.Id, config.baseUrl);

            return {
              courseId: item.OrgUnit.Id,
              courseName: item.OrgUnit.Name,
              assignments,
            };
          } catch (error: any) {
            // 403 means no access (past course, etc) - log and skip
            if (error?.status === 403) {
              log(
                "DEBUG",
                `get_assignments: 403 Forbidden for course ${item.OrgUnit.Id} (${item.OrgUnit.Name}) - skipping`
              );
              return null;
            }
            throw error; // Re-throw other errors
          }
        });

        const results = await Promise.allSettled(assignmentPromises);
        const courses = results
          .filter(
            (r): r is PromiseFulfilledResult<any> =>
              r.status === "fulfilled" && r.value !== null
          )
          .map((r) => r.value);

        log(
          "INFO",
          `get_assignments: Retrieved assignments for ${courses.length} courses (out of ${enrollmentResponse.Items.length} enrolled)`
        );
        return toolResponse({ courses });
      } catch (error) {
        // Temporary: log full error details to stderr for debugging
        if (error instanceof Error) {
          log("ERROR", `get_assignments failed: ${error.message}\n${error.stack}`);
        }
        return sanitizeError(error);
      }
    }
  );
}
