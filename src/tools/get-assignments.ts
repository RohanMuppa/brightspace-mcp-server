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
import { assignmentUrl, quizUrl } from "../utils/deep-links.js";
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
interface QuizReadData {
  QuizId: number;
  Name: string;
  Description: { Text: string; Html: string } | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsActive: boolean;
  AttemptsAllowed: {
    IsUnlimited: boolean;
    NumberOfAttemptsAllowed: number | null;
  } | null;
  TimeLimit: {
    IsEnforced: boolean;
    ShowClock: boolean;
    TimeLimitValue: number; // minutes
  } | null;
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

  // Fetch dropbox folders and quizzes in parallel
  const [dropboxResult, quizResult] = await Promise.allSettled([
    apiClient.get<{ Objects: DropboxFolder[] } | DropboxFolder[]>(
      apiClient.le(courseId, "/dropbox/folders/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    ),
    apiClient.get<{ Objects: QuizReadData[] } | QuizReadData[]>(
      apiClient.le(courseId, "/quizzes/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    ),
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

    for (const quiz of quizzes) {
      // Skip inactive quizzes
      if (!quiz.IsActive) continue;

      // Fetch quiz attempts
      let attempts: QuizAttemptData[] = [];
      try {
        const attemptsRaw = await apiClient.get<{ Objects: QuizAttemptData[] } | QuizAttemptData[]>(
          apiClient.le(courseId, `/quizzes/${quiz.QuizId}/attempts/`),
          { ttl: DEFAULT_CACHE_TTLS.assignments }
        );
        // D2L attempts endpoint may return paged { Objects: [...] } or flat array
        attempts = Array.isArray(attemptsRaw) ? attemptsRaw : (attemptsRaw as any).Objects ?? [];
      } catch (error: any) {
        // 404 means no attempts yet - that's fine
        if (error?.status !== 404 && error?.status !== 403) {
          log("DEBUG", `Failed to fetch attempts for quiz ${quiz.QuizId}`, error);
        }
      }

      // Calculate remaining attempts
      const completedAttempts = attempts.filter((a) => a.IsCompleted);
      let attemptsRemaining: number | string = "Unlimited";
      let attemptWarning: string | null = null;

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

      // Build quiz object
      const quizAssignment = {
        type: "quiz",
        id: quiz.QuizId,
        name: quiz.Name,
        url: baseUrl ? quizUrl(baseUrl, courseId, quiz.QuizId) : null,
        instructions: quiz.Description?.Html
          ? convertHtmlToMarkdown(quiz.Description.Html)
          : { markdown: "", html: "" },
        dueDate: quiz.DueDate,
        startDate: quiz.StartDate,
        endDate: quiz.EndDate,
        timeLimit: quiz.TimeLimit?.IsEnforced ? quiz.TimeLimit.TimeLimitValue : null,
        attemptsAllowed: quiz.AttemptsAllowed?.IsUnlimited
          ? "Unlimited"
          : quiz.AttemptsAllowed?.NumberOfAttemptsAllowed ?? null,
        attemptsUsed: completedAttempts.length,
        attemptsRemaining,
        attemptWarning,
        bestScore: completedAttempts.length > 0
          ? Math.max(...completedAttempts.map((a) => a.Score ?? 0))
          : null,
      };

      assignments.push(quizAssignment);
    }
  } else {
    // Log quiz fetch failure but don't throw
    log("DEBUG", `Failed to fetch quizzes for course ${courseId}`, quizResult.reason);
  }

  return assignments;
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
