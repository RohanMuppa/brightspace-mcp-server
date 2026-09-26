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
import { assignmentUrl, quizUrl, discussionUrl } from "../utils/deep-links.js";
import type { AppConfig } from "../types/index.js";
import { resolveCourses, type CourseRef } from "./resolve-courses.js";
import { fetchCourseCalendarEvents, type CalendarEvent } from "./calendar-events.js";

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

interface DiscussionForum {
  ForumId: number;
  Name: string;
  IsHidden: boolean;
}

interface DiscussionTopic {
  TopicId: number;
  Name: string;
  DueDate: string | null;
  IsHidden: boolean;
}

interface UpcomingItem {
  type: "assignment" | "quiz" | "discussion" | "event";
  id: number;
  title: string;
  courseId: number;
  courseName: string | null;
  dueDate: string;
  startDate: string | null;
  endDate: string | null;
  location?: string;
  url: string;
}

/** D2L list endpoints return either a paged { Objects: [...] } or a flat array. */
function unwrapList<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : ((raw as any)?.Objects ?? []);
}

/**
 * Collect every graded, dated discussion topic for one course.
 *
 * Forums carry no due date themselves; it lives on each topic. A hidden forum
 * hides everything inside it, however visible its topics claim to be, so it is
 * skipped without asking for its topics at all. A forum whose topics fail to
 * load (e.g. no access) is skipped rather than failing the whole course,
 * matching `getForumsOverview` in get-discussions.ts.
 */
async function fetchDiscussionDueTopics(
  apiClient: D2LApiClient,
  courseId: number
): Promise<DiscussionTopic[]> {
  const forums = await apiClient.get<{ Objects: DiscussionForum[] } | DiscussionForum[]>(
    apiClient.le(courseId, "/discussions/forums/"),
    { ttl: DEFAULT_CACHE_TTLS.assignments }
  );

  const topics: DiscussionTopic[] = [];
  for (const forum of unwrapList<DiscussionForum>(forums)) {
    if (forum.IsHidden === true) continue;

    try {
      const forumTopics = await apiClient.get<
        { Objects: DiscussionTopic[] } | DiscussionTopic[]
      >(
        apiClient.le(courseId, `/discussions/forums/${forum.ForumId}/topics/`),
        { ttl: DEFAULT_CACHE_TTLS.assignments }
      );
      topics.push(...unwrapList<DiscussionTopic>(forumTopics));
    } catch (error) {
      log(
        "DEBUG",
        `get_upcoming_due_dates: failed to fetch topics for forum ${forum.ForumId} in course ${courseId}`,
        error
      );
    }
  }

  return topics;
}

/**
 * Calendar events as upcoming items, minus the ones Brightspace generated from
 * an item already in `items` — that item is the better record of the same
 * deadline. Hand-made events (exams, labs) have no source item and always stay.
 */
function calendarItems(events: CalendarEvent[], items: UpcomingItem[]): UpcomingItem[] {
  const listed = new Set(items.map((item) => `${item.type}:${item.id}`));
  return events
    .filter((event) => !event.generatedFrom || !listed.has(`${event.generatedFrom.type}:${event.generatedFrom.id}`))
    .map((event) => ({
      type: "event",
      id: event.id,
      title: event.title,
      courseId: event.courseId,
      courseName: event.courseName,
      dueDate: event.start,
      startDate: null,
      endDate: event.end ?? null,
      ...(event.location ? { location: event.location } : {}),
      url: event.url,
    }));
}

/**
 * Collect every dated assignment, quiz, graded discussion topic, and calendar
 * event starting in [from, to] for one course.
 *
 * No submissions or attempts: the due date lives on the item itself, which is
 * what makes this cheap enough to run across all enrolled courses. A
 * discussion topic counts only when it has a DueDate — an ungraded chat forum
 * has none and should not clutter the list.
 */
async function fetchCourseDueItems(
  apiClient: D2LApiClient,
  baseUrl: string,
  course: CourseRef,
  from: number,
  to: number
): Promise<UpcomingItem[]> {
  const [dropboxResult, quizResult, discussionResult, calendarResult] = await Promise.allSettled([
    apiClient.get<{ Objects: DropboxFolder[] } | DropboxFolder[]>(
      apiClient.le(course.id, "/dropbox/folders/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    ),
    apiClient.get<{ Objects: QuizReadData[] } | QuizReadData[]>(
      apiClient.le(course.id, "/quizzes/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    ),
    fetchDiscussionDueTopics(apiClient, course.id),
    fetchCourseCalendarEvents(apiClient, baseUrl, course, from, to),
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

  if (discussionResult.status === "fulfilled") {
    for (const topic of discussionResult.value) {
      if (topic.IsHidden === true) continue;
      if (!topic.DueDate) continue;

      items.push({
        type: "discussion",
        id: topic.TopicId,
        title: topic.Name,
        courseId: course.id,
        courseName: course.name,
        dueDate: topic.DueDate,
        startDate: null,
        endDate: null,
        url: discussionUrl(baseUrl, course.id, topic.TopicId),
      });
    }
  } else {
    log("DEBUG", `get_upcoming_due_dates: failed to fetch discussions for course ${course.id}`, discussionResult.reason);
  }

  if (calendarResult.status === "fulfilled") {
    items.push(...calendarItems(calendarResult.value, items));
  } else {
    log("DEBUG", `get_upcoming_due_dates: failed to fetch calendar events for course ${course.id}`, calendarResult.reason);
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
        "Fetch upcoming due dates across all your courses, derived from the due dates on assignments (dropbox folders), quizzes, and graded discussion topics themselves, plus course calendar events such as exams and labs (type: event). Use this when the user asks about deadlines, what's due, upcoming work, or what they need to do this week.",
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
          courses.map((course) => fetchCourseDueItems(apiClient, config.baseUrl, course, now, windowEnd))
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
