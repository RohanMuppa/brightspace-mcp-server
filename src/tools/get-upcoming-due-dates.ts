/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import {
  GetUpcomingDueDatesSchema,
} from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { assignmentUrl, quizUrl } from "../utils/deep-links.js";
import type { AppConfig } from "../types/index.js";

interface DropboxFolder {
  Id: number;
  Name: string;
  DueDate: string | null;
  IsHidden: boolean;
}

interface QuizReadData {
  QuizId: number;
  Name: string;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsActive: boolean;
}

interface EnrollmentItem {
  OrgUnit: {
    Id: number;
    Name: string;
    Code: string;
  };
  Access: {
    IsActive: boolean;
  };
}

interface EnrollmentResponse {
  Items: EnrollmentItem[];
}

interface CourseRef {
  id: number;
  name: string | null;
}

interface UpcomingItem {
  type: "assignment" | "quiz";
  id: number;
  title: string;
  courseId: number;
  courseName: string | null;
  dueDate: string;
  startDate: string | null;
  endDate: string | null;
  url: string;
}

/** D2L list endpoints return either a paged { Objects: [...] } or a flat array. */
function unwrapList<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : ((raw as any)?.Objects ?? []);
}

/**
 * Resolve which courses to query, and their names.
 *
 * A tool-level courseId bypasses the configured course filter, but enrollments
 * are still fetched so the course can be named.
 */
async function resolveCourses(
  apiClient: D2LApiClient,
  config: AppConfig,
  courseId?: number
): Promise<CourseRef[]> {
  let items: EnrollmentItem[] = [];

  try {
    const response = await apiClient.get<EnrollmentResponse>(
      apiClient.lp("/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true"),
      { ttl: DEFAULT_CACHE_TTLS.enrollments }
    );
    items = response.Items ?? [];
  } catch (error) {
    // Without enrollments there is no course list to walk, so only the explicit
    // single-course case can continue (with an unnamed course).
    if (!courseId) throw error;
    log("DEBUG", "get_upcoming_due_dates: could not fetch enrollments for course name", error);
  }

  if (courseId) {
    const match = items.find((item) => item.OrgUnit.Id === courseId);
    return [{ id: courseId, name: match?.OrgUnit.Name ?? null }];
  }

  const filtered = applyCourseFilter(
    items.map((item) => ({
      id: item.OrgUnit.Id,
      name: item.OrgUnit.Name,
      code: item.OrgUnit.Code,
      isActive: item.Access.IsActive,
    })),
    config.courseFilter
  );

  return filtered.map((course) => ({ id: course.id, name: course.name }));
}

/**
 * Collect every dated assignment and quiz for one course.
 *
 * Two API calls per course, no submissions or attempts: the due date lives on
 * the item itself, which is what makes this cheap enough to run across all
 * enrolled courses.
 */
async function fetchCourseDueItems(
  apiClient: D2LApiClient,
  baseUrl: string,
  course: CourseRef
): Promise<UpcomingItem[]> {
  const [dropboxResult, quizResult] = await Promise.allSettled([
    apiClient.get<{ Objects: DropboxFolder[] } | DropboxFolder[]>(
      apiClient.le(course.id, "/dropbox/folders/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    ),
    apiClient.get<{ Objects: QuizReadData[] } | QuizReadData[]>(
      apiClient.le(course.id, "/quizzes/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    ),
  ]);

  const items: UpcomingItem[] = [];

  if (dropboxResult.status === "fulfilled") {
    for (const folder of unwrapList<DropboxFolder>(dropboxResult.value)) {
      if (folder.IsHidden === true) continue;
      if (!folder.DueDate) continue;

      items.push({
        type: "assignment",
        id: folder.Id,
        title: folder.Name,
        courseId: course.id,
        courseName: course.name,
        dueDate: folder.DueDate,
        startDate: null,
        endDate: null,
        url: assignmentUrl(baseUrl, course.id, folder.Id),
      });
    }
  } else {
    // 403 for past courses and similar: log and keep the other courses.
    log("DEBUG", `get_upcoming_due_dates: failed to fetch dropbox folders for course ${course.id}`, dropboxResult.reason);
  }

  if (quizResult.status === "fulfilled") {
    for (const quiz of unwrapList<QuizReadData>(quizResult.value)) {
      if (quiz.IsActive === false) continue;

      // Many instructors set only an End Date, which is the effective deadline.
      const dueDate = quiz.DueDate ?? quiz.EndDate;
      if (!dueDate) continue;

      items.push({
        type: "quiz",
        id: quiz.QuizId,
        title: quiz.Name,
        courseId: course.id,
        courseName: course.name,
        dueDate,
        startDate: quiz.StartDate ?? null,
        endDate: quiz.EndDate ?? null,
        url: quizUrl(baseUrl, course.id, quiz.QuizId),
      });
    }
  } else {
    log("DEBUG", `get_upcoming_due_dates: failed to fetch quizzes for course ${course.id}`, quizResult.reason);
  }

  return items;
}

/**
 * Register get_upcoming_due_dates tool
 */
export function registerGetUpcomingDueDates(
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
): void {
  server.registerTool(
    "get_upcoming_due_dates",
    {
      title: "Get Upcoming Due Dates",
      description:
        "Fetch upcoming due dates across all your courses, derived from the due dates on assignments (dropbox folders) and quizzes themselves. Use this when the user asks about deadlines, what's due, upcoming work, or what they need to do this week.",
      inputSchema: GetUpcomingDueDatesSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_upcoming_due_dates tool called", { args });

        // Parse and validate input
        const { daysAhead, courseId } = GetUpcomingDueDatesSchema.parse(args);

        // Build time window
        const now = Date.now();
        const windowEnd = now + daysAhead * 24 * 60 * 60 * 1000;

        const courses = await resolveCourses(apiClient, config, courseId);
        log("DEBUG", `get_upcoming_due_dates: querying ${courses.length} course(s), window=${daysAhead} days`);

        // Fetch every course in parallel; the API client rate limits itself
        const results = await Promise.allSettled(
          courses.map((course) => fetchCourseDueItems(apiClient, config.baseUrl, course))
        );

        const items = results.flatMap((result) => {
          if (result.status === "fulfilled") return result.value;
          log("DEBUG", "get_upcoming_due_dates: skipping course after fetch failure", result.reason);
          return [];
        });

        // Keep what falls inside the window, soonest first
        const upcoming = items
          .filter((item) => {
            const due = new Date(item.dueDate).getTime();
            return Number.isFinite(due) && due >= now && due <= windowEnd;
          })
          .sort(
            (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
          );

        log(
          "INFO",
          `get_upcoming_due_dates: Retrieved ${upcoming.length} items across ${courses.length} courses`
        );
        return toolResponse(upcoming);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
