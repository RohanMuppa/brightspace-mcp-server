/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllObjects } from "../api/paginate.js";
import {
  GetUpcomingDueDatesSchema,
} from "./schemas.js";
import { toolResponse, toolResponseWithNotice, sanitizeError, isAuthUnavailable, authPendingNotice, throwIfCredentialRejected } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { quizUrl, discussionUrl } from "../utils/deep-links.js";
import { assignmentLinkResolver } from "./assignment-links.js";
import { dueIn } from "../utils/due-in.js";
import type { AppConfig } from "../types/index.js";
import { resolveCourses, type CourseRef } from "./resolve-courses.js";
import { fetchCourseCalendarEvents, eventEndsAt, type CalendarEvent } from "./calendar-events.js";

interface DropboxFolder {
  GroupTypeId?: number | null;
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
  /** Relative phrasing of dueDate ("in 3 days", "yesterday"), so a caller never has to do its own date math. */
  dueIn: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Present on an all-day event: dueDate and endDate are its first and last day. */
  allDay?: true;
  location?: string;
  url: string;
}

/** The sources one course's upcoming items are read from. */
type DueSource = "assignments" | "quizzes" | "discussions" | "calendar";

/** One course's upcoming items, and the sources that could not be read. */
interface CourseDueItems {
  items: UpcomingItem[];
  unavailable: DueSource[];
}

/**
 * Whether a failed source must be reported rather than skipped. A 403 means
 * the tool is restricted or switched off in that course (a past course, a
 * course with no quizzes): nothing was missed. Anything else (a 404, a 5xx, a
 * dropped connection) leaves a hole the caller would read as "nothing due".
 */
function isReportableFailure(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status !== 403;
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
 * matching `getForumsOverview` in get-discussions.ts; `incomplete` marks a
 * skip that was not a 403, so the caller can say topics may be missing.
 */
async function fetchDiscussionDueTopics(
  apiClient: D2LApiClient,
  courseId: number
): Promise<{ topics: DiscussionTopic[]; incomplete: boolean }> {
  const forums = await apiClient.get<{ Objects: DiscussionForum[] } | DiscussionForum[]>(
    apiClient.le(courseId, "/discussions/forums/"),
    { ttl: DEFAULT_CACHE_TTLS.assignments }
  );

  const topics: DiscussionTopic[] = [];
  let incomplete = false;
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
      if (isAuthUnavailable(error)) throw error;
      if (isReportableFailure(error)) incomplete = true;
      log(
        "DEBUG",
        `get_upcoming_due_dates: failed to fetch topics for forum ${forum.ForumId} in course ${courseId}`,
        error
      );
    }
  }

  return { topics, incomplete };
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
      dueIn: dueIn(event.start),
      startDate: null,
      endDate: event.end ?? null,
      ...(event.allDay ? { allDay: true as const } : {}),
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
): Promise<CourseDueItems> {
  const [dropboxResult, quizResult, discussionResult, calendarResult] = await Promise.allSettled([
    apiClient.get<{ Objects: DropboxFolder[] } | DropboxFolder[]>(
      apiClient.le(course.id, "/dropbox/folders/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    ),
    // Quizzes are paged; a course with many of them spills past page one.
    fetchAllObjects<QuizReadData>(apiClient, apiClient.le(course.id, "/quizzes/"), {
      ttl: DEFAULT_CACHE_TTLS.assignments,
    }),
    fetchDiscussionDueTopics(apiClient, course.id),
    fetchCourseCalendarEvents(apiClient, baseUrl, course, from, to),
  ]);

  // Each route may fail on its own without costing the others, but a failed
  // sign-in means none of them answered: report that, not an empty course.
  for (const result of [dropboxResult, quizResult, discussionResult, calendarResult]) {
    if (result.status === "rejected" && isAuthUnavailable(result.reason)) throw result.reason;
  }

  const items: UpcomingItem[] = [];
  const unavailable: DueSource[] = [];
  const assignmentLink = assignmentLinkResolver(apiClient, baseUrl, course.id);

  if (dropboxResult.status === "fulfilled") {
    for (const folder of unwrapList<DropboxFolder>(dropboxResult.value)) {
      if (folder.IsHidden === true) continue;
      if (!folder.DueDate) continue;
      // Check the window before resolving the link: a group folder's link
      // costs group-membership requests, wasted on an item the handler's
      // window filter would drop anyway (issue #230).
      const due = new Date(folder.DueDate).getTime();
      if (!Number.isFinite(due) || due < from || due > to) continue;
      const link = await assignmentLink(folder);

      items.push({
        type: "assignment",
        id: folder.Id,
        title: folder.Name,
        courseId: course.id,
        courseName: course.name,
        dueDate: folder.DueDate,
        dueIn: dueIn(folder.DueDate),
        startDate: null,
        endDate: null,
        ...link,
        url: link.url!,
      });
    }
  } else {
    // 403 for past courses and similar: log and keep the other courses.
    if (isReportableFailure(dropboxResult.reason)) unavailable.push("assignments");
    log("DEBUG", `get_upcoming_due_dates: failed to fetch dropbox folders for course ${course.id}`, dropboxResult.reason);
  }

  if (quizResult.status === "fulfilled") {
    for (const quiz of quizResult.value) {
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
        dueIn: dueIn(dueDate),
        startDate: quiz.StartDate ?? null,
        endDate: quiz.EndDate ?? null,
        url: quizUrl(baseUrl, course.id, quiz.QuizId),
      });
    }
  } else {
    if (isReportableFailure(quizResult.reason)) unavailable.push("quizzes");
    log("DEBUG", `get_upcoming_due_dates: failed to fetch quizzes for course ${course.id}`, quizResult.reason);
  }

  if (discussionResult.status === "fulfilled") {
    if (discussionResult.value.incomplete) unavailable.push("discussions");
    for (const topic of discussionResult.value.topics) {
      if (topic.IsHidden === true) continue;
      if (!topic.DueDate) continue;

      items.push({
        type: "discussion",
        id: topic.TopicId,
        title: topic.Name,
        courseId: course.id,
        courseName: course.name,
        dueDate: topic.DueDate,
        dueIn: dueIn(topic.DueDate),
        startDate: null,
        endDate: null,
        url: discussionUrl(baseUrl, course.id, topic.TopicId),
      });
    }
  } else {
    if (isReportableFailure(discussionResult.reason)) unavailable.push("discussions");
    log("DEBUG", `get_upcoming_due_dates: failed to fetch discussions for course ${course.id}`, discussionResult.reason);
  }

  if (calendarResult.status === "fulfilled") {
    items.push(...calendarItems(calendarResult.value, items));
  } else {
    if (isReportableFailure(calendarResult.reason)) unavailable.push("calendar");
    log("DEBUG", `get_upcoming_due_dates: failed to fetch calendar events for course ${course.id}`, calendarResult.reason);
  }

  return { items, unavailable };
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
      annotations: { readOnlyHint: true },
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

        // A pending sign-in only means that course's routes never answered —
        // it says nothing about the other courses, whose requests may already
        // have gone out independently. Collect it rather than failing the
        // whole call and losing every course that *did* answer.
        const pendingCourseIds: number[] = [];
        // Anything else that failed still must not make items vanish: an
        // assignment missing from a list that looks complete reads as
        // "nothing due" (#383).
        const failedCourses: Array<{ courseId: number; sources: DueSource[] }> = [];
        let firstAuthError: unknown = null;
        const items = results.flatMap((result, i) => {
          if (result.status === "fulfilled") {
            if (result.value.unavailable.length > 0) {
              failedCourses.push({ courseId: courses[i].id, sources: result.value.unavailable });
            }
            return result.value.items;
          }
          if (isAuthUnavailable(result.reason)) {
            pendingCourseIds.push(courses[i].id);
            firstAuthError ??= result.reason;
            log("DEBUG", `get_upcoming_due_dates: sign-in pending for course ${courses[i].id}`, result.reason);
            return [];
          }
          failedCourses.push({
            courseId: courses[i].id,
            sources: ["assignments", "quizzes", "discussions", "calendar"],
          });
          log("DEBUG", "get_upcoming_due_dates: skipping course after fetch failure", result.reason);
          return [];
        });

        // Keep what falls inside the window, soonest first. An all-day
        // event counts until its last day ends, not just until its midnight start.
        const upcoming = items
          .filter((item) => {
            const due = new Date(item.dueDate).getTime();
            const until = item.allDay
              ? eventEndsAt({ start: item.dueDate, end: item.endDate ?? undefined, allDay: true })
              : due;
            return Number.isFinite(due) && until >= now && due <= windowEnd;
          })
          .sort(
            (a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
          );

        log(
          "INFO",
          `get_upcoming_due_dates: Retrieved ${upcoming.length} items across ${courses.length} courses` +
          (pendingCourseIds.length > 0 ? ` (${pendingCourseIds.length} pending sign-in)` : "") +
          (failedCourses.length > 0 ? ` (${failedCourses.length} incomplete)` : "")
        );

        // The response is always a bare array, pending sign-in or not — a
        // shape change would break every existing caller. A pending or
        // incomplete course instead adds a second content block carrying the
        // notice, which names which course ids are unavailable.
        const notices: string[] = [];
        if (pendingCourseIds.length > 0) {
          throwIfCredentialRejected(firstAuthError);
          notices.push(
            "Sign-in to Brightspace is still in progress, so upcoming due dates for " +
              `${pendingCourseIds.length} course(s) (${pendingCourseIds.join(", ")}) could not be fetched ` +
              `yet. ${authPendingNotice(firstAuthError)} Call get_upcoming_due_dates again once sign-in finishes.`
          );
        }
        if (failedCourses.length > 0) {
          const listed = failedCourses
            .map(({ courseId, sources }) => `${courseId} (${sources.join(", ")})`)
            .join("; ");
          notices.push(
            `Some upcoming items could not be read from Brightspace, so they may be missing from this list: ${listed}. ` +
              "Do not report these as having nothing due: call get_upcoming_due_dates again with that courseId."
          );
        }
        if (notices.length === 0) {
          return toolResponse(upcoming);
        }
        return toolResponseWithNotice(upcoming, notices.join(" "));
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
