/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllItems } from "../api/paginate.js";
import {
  GetMyGradesSchema,
} from "./schemas.js";
import {
  toolResponse,
  sanitizeError,
  errorResponse,
  isAuthUnavailable,
  authPendingNotice,
} from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { gradebookUrl, quizUrl } from "../utils/deep-links.js";
import type { AppConfig } from "../types/index.js";

interface GradeValue {
  GradeObjectIdentifier: string;
  GradeObjectName: string;
  DisplayedGrade: string;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  WeightedNumerator: number | null;
  WeightedDenominator: number | null;
  Comments: { Text: string; Html: string } | null;
  PrivateComments: { Text: string; Html: string } | null;
  LastModified: string;
  ReleasedDate: string | null;
}

interface QuizListItem {
  QuizId: number;
  GradeItemId?: number | null;
}

/**
 * The quiz a grade row is scored from can hold feedback the gradebook does
 * not, and the student API cannot read it: quiz attempts are refused to
 * students, and some quizzes only show feedback inside a restricted viewer.
 */
const QUIZ_FEEDBACK_NOTE =
  "The gradebook has no comment for this item, but it is scored from a quiz, and quiz " +
  "feedback lives on the quiz's own submissions page, which Brightspace does not expose " +
  "to the student API. Feedback may exist there, sometimes viewable only in a restricted " +
  "browser such as Respondus LockDown Browser. Open feedbackUrl to check; do not report " +
  "this item as having no feedback.";

/**
 * The course's quizzes, or none when the route refuses or fails. A missing
 * quiz list only costs the feedback links, never the grades themselves.
 */
async function fetchQuizzes(apiClient: D2LApiClient, courseId: number): Promise<QuizListItem[]> {
  try {
    const raw = await apiClient.get<{ Objects: QuizListItem[] } | QuizListItem[]>(
      apiClient.le(courseId, "/quizzes/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    );
    return Array.isArray(raw) ? raw : raw?.Objects ?? [];
  } catch (error) {
    log("DEBUG", `get_my_grades: quiz list unavailable for course ${courseId}`, error);
    return [];
  }
}

/**
 * Clean grade rows. Rows scored from a quiz also carry feedbackUrl, and a
 * feedbackNote when the gradebook comment is empty; other rows are unchanged.
 */
function toGradeItems(
  gradeValues: GradeValue[],
  quizzes: QuizListItem[],
  baseUrl: string,
  courseId: number
) {
  const quizByGradeItem = new Map(
    quizzes
      .filter((q) => q.GradeItemId != null)
      .map((q) => [String(q.GradeItemId), q.QuizId])
  );
  return gradeValues.map((gv) => {
    const comments = gv.Comments?.Text || null;
    const quizId = quizByGradeItem.get(String(gv.GradeObjectIdentifier));
    return {
      name: gv.GradeObjectName,
      displayGrade: gv.DisplayedGrade,
      pointsNumerator: gv.PointsNumerator,
      pointsDenominator: gv.PointsDenominator,
      weightedNumerator: gv.WeightedNumerator,
      weightedDenominator: gv.WeightedDenominator,
      comments,
      lastModified: gv.LastModified,
      ...(quizId === undefined ? {} : {
        feedbackUrl: quizUrl(baseUrl, courseId, quizId),
        ...(comments ? {} : { feedbackNote: QUIZ_FEEDBACK_NOTE }),
      }),
    };
  });
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
    StartDate: string | null;
    EndDate: string | null;
    LastAccessed: string | null;
  };
}

/**
 * Register get_my_grades tool
 */
export function registerGetMyGrades(
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
): void {
  server.registerTool(
    "get_my_grades",
    {
      title: "Get My Grades",
      description:
        "Fetch your grade breakdown for a specific course or all enrolled courses. Shows grade items with points, percentages, and comments. Use this when the user asks about grades, scores, marks, GPA, academic performance, or how they're doing in a class.",
      inputSchema: GetMyGradesSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_my_grades tool called", { args });

        // Parse and validate input
        const { courseId } = GetMyGradesSchema.parse(args);

        // Single course case
        if (courseId) {
          const path = apiClient.le(courseId, "/grades/values/myGradeValues/");
          const quizzesPromise = fetchQuizzes(apiClient, courseId);
          let gradeValues: GradeValue[];
          try {
            gradeValues = await apiClient.get<GradeValue[]>(path, {
              ttl: DEFAULT_CACHE_TTLS.grades,
            });
          } catch (error: any) {
            // A 403 here means the tenant restricts the grade API for this
            // course (an institutional policy, not a bug). The error shape
            // stays the same plain isError text result every other tool
            // error uses -- only the text itself changes, naming the
            // gradebook URL so the student can see their grade there
            // instead.
            if (error?.status === 403) {
              const url = gradebookUrl(config.baseUrl, courseId);
              log("INFO", `get_my_grades: 403 for course ${courseId} - grade API access restricted`);
              return errorResponse(
                "Your institution restricts grade API access for this course. " +
                `View your grades directly in Brightspace: ${url}`
              );
            }
            // A pending sign-in is not an empty gradebook: the route never
            // answered, so the result says so instead of reporting zero grades
            // as if that were a real measurement. The envelope stays a
            // success — existing callers that only read `grades` keep
            // working — with authPending/notice added for callers that want
            // to tell "no grades" apart from "couldn't check".
            if (isAuthUnavailable(error)) {
              log("DEBUG", `get_my_grades: sign-in pending for course ${courseId}`, error);
              return toolResponse({
                courseId,
                grades: [],
                authPending: true,
                notice:
                  "Sign-in to Brightspace is still in progress, so grades for this course " +
                  `could not be fetched yet. ${authPendingNotice(error)} Call get_my_grades again ` +
                  "once sign-in finishes.",
              });
            }
            throw error;
          }

          // Map to clean objects
          const grades = toGradeItems(gradeValues, await quizzesPromise, config.baseUrl, courseId);

          log("INFO", `get_my_grades: Retrieved ${grades.length} grade items for course ${courseId}`);
          return toolResponse({ courseId, grades });
        }

        // All courses case
        // First, fetch enrolled courses. isActive=true has to track the
        // configured policy rather than being pinned on: a user who set
        // activeOnly:false is asking to see archived courses, and a query that
        // withholds them leaves applyCourseFilter nothing to let through.
        const enrollmentPath = apiClient.lp(
          `/enrollments/myenrollments/?orgUnitTypeId=3${config.courseFilter.activeOnly ? "&isActive=true" : ""}`
        );
        // Enrollments arrive one page at a time; follow the bookmark chain so a
        // long enrollment history does not silently lose its later courses.
        const enrollmentItems = await fetchAllItems<EnrollmentItem>(
          apiClient,
          enrollmentPath,
          { ttl: DEFAULT_CACHE_TTLS.enrollments }
        );

        // Apply course filter
        const filteredEnrollments = applyCourseFilter(
          enrollmentItems.map(item => ({
            id: item.OrgUnit.Id,
            name: item.OrgUnit.Name,
            code: item.OrgUnit.Code,
            isActive: item.Access.IsActive,
            canAccess: item.Access.CanAccess,
            startDate: item.Access.StartDate,
            endDate: item.Access.EndDate,
            ...item,
          })),
          config.courseFilter
        );

        // Fetch grades for each course (handle 403s gracefully)
        const gradePromises = filteredEnrollments.map(async (item) => {
          try {
            const path = apiClient.le(
              item.OrgUnit.Id,
              "/grades/values/myGradeValues/"
            );
            const [gradeValues, quizzes] = await Promise.all([
              apiClient.get<GradeValue[]>(path, { ttl: DEFAULT_CACHE_TTLS.grades }),
              fetchQuizzes(apiClient, item.OrgUnit.Id),
            ]);

            const grades = toGradeItems(gradeValues, quizzes, config.baseUrl, item.OrgUnit.Id);

            return {
              restricted: false as const,
              courseId: item.OrgUnit.Id,
              courseName: item.OrgUnit.Name,
              grades,
            };
          } catch (error: any) {
            // A 403 means the tenant restricts the grade API for this course
            // (an institutional policy, not missing access like a dropped
            // past course). Rather than dropping the course with no trace,
            // it is surfaced in a separate, purely additive
            // `restrictedCourses` array; `courses` itself is unaffected.
            if (error?.status === 403) {
              log(
                "DEBUG",
                `get_my_grades: 403 Forbidden for course ${item.OrgUnit.Id} (${item.OrgUnit.Name}) - grade API access restricted`
              );
              return {
                restricted: true as const,
                courseId: item.OrgUnit.Id,
                courseName: item.OrgUnit.Name,
                gradeUrl: gradebookUrl(config.baseUrl, item.OrgUnit.Id),
              };
            }
            // A pending sign-in only means this course's route never
            // answered — it says nothing about the other courses, whose
            // requests may already have gone out independently. Mark this one
            // rather than failing the whole call and losing every course that
            // *did* answer.
            if (isAuthUnavailable(error)) {
              log(
                "DEBUG",
                `get_my_grades: sign-in pending for course ${item.OrgUnit.Id} (${item.OrgUnit.Name})`
              );
              return {
                courseId: item.OrgUnit.Id,
                courseName: item.OrgUnit.Name,
                authPending: true as const,
                authError: error,
              };
            }
            throw error; // Re-throw other errors
          }
        });

        const results = await Promise.allSettled(gradePromises);
        const settled = results
          .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
          .map((r) => r.value);

        const pending = settled.filter((c) => c.authPending);
        const restrictedCourses = settled
          .filter((c) => c.restricted)
          .map(({ restricted: _restricted, ...rest }) => rest);
        const courses = settled
          .filter((c) => !c.authPending && !c.restricted)
          .map(({ courseId, courseName, grades }) => ({ courseId, courseName, grades }));

        log(
          "INFO",
          `get_my_grades: Retrieved grades for ${courses.length} courses, ` +
          `${restrictedCourses.length} restricted (out of ${enrollmentItems.length} enrolled` +
          `${pending.length > 0 ? `, ${pending.length} pending sign-in` : ""})`
        );

        // Pending courses keep `grades: []` so callers that read
        // `courses[i].grades` still get an array; authPending marks it as
        // unchecked rather than empty. `restrictedCourses` is always present
        // (even empty) so callers can rely on the field existing.
        const response: Record<string, unknown> = {
          courses: [
            ...courses,
            ...pending.map(({ courseId, courseName }) => ({
              courseId,
              courseName,
              grades: [],
              authPending: true as const,
            })),
          ],
          restrictedCourses,
        };
        if (pending.length > 0) {
          response.authPending = true;
          response.unavailableCourseIds = pending.map((c) => c.courseId);
          response.notice =
            "Sign-in to Brightspace is still in progress, so grades for " +
            `${pending.length} course(s) (${pending.map((c) => c.courseId).join(", ")}) could not be ` +
            `fetched yet. ${authPendingNotice(pending[0].authError)} Call get_my_grades again once ` +
            "sign-in finishes.";
        }
        return toolResponse(response);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
