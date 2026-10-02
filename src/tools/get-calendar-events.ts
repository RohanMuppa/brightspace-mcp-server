/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { GetCalendarEventsSchema } from "./schemas.js";
import { toolResponse, toolResponseWithNotice, errorResponse, sanitizeError, isAuthUnavailable, authPendingNotice } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { resolveCourses } from "./resolve-courses.js";
import { fetchCourseCalendarEvents } from "./calendar-events.js";
import type { AppConfig } from "../types/index.js";

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Register get_calendar_events tool
 */
export function registerGetCalendarEvents(
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
): void {
  server.registerTool(
    "get_calendar_events",
    {
      title: "Get Calendar Events",
      description:
        "Fetch course calendar events — exams, midterms, labs, recitations, review sessions, schedule changes, and deadlines instructors typed straight onto the calendar — across all your courses or one course, in a time window (default: the next 7 days). Use this when the user asks when an exam is, what's on their calendar, or what's happening this week.",
      inputSchema: GetCalendarEventsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_calendar_events tool called", { args });

        const { courseId, from, to, includeGenerated } = GetCalendarEventsSchema.parse(args);

        const windowStart = from ? new Date(from).getTime() : Date.now();
        const windowEnd = to ? new Date(to).getTime() : windowStart + DEFAULT_WINDOW_MS;

        // An inverted window matches nothing, and an empty list reads as "no events".
        if (windowEnd < windowStart) {
          return errorResponse(
            from
              ? `to (${to}) is before from (${from}). Pass a to that is on or after from.`
              : `to (${to}) is in the past, and from defaults to now. Pass from as well to look at past events.`
          );
        }

        const courses = await resolveCourses(apiClient, config, courseId);

        const results = await Promise.allSettled(
          courses.map((course) =>
            fetchCourseCalendarEvents(apiClient, config.baseUrl, course, windowStart, windowEnd)
          )
        );

        // A pending sign-in only means that course's route never answered —
        // it says nothing about the other courses, whose requests may already
        // have gone out independently. Collect it rather than failing the
        // whole call and losing every course that *did* answer.
        const pendingCourseIds: number[] = [];
        let firstAuthError: unknown = null;
        const events = results
          .flatMap((result, i) => {
            if (result.status === "fulfilled") return result.value;
            if (isAuthUnavailable(result.reason)) {
              pendingCourseIds.push(courses[i].id);
              firstAuthError ??= result.reason;
              log("DEBUG", `get_calendar_events: sign-in pending for course ${courses[i].id}`, result.reason);
              return [];
            }
            log("DEBUG", `get_calendar_events: skipping course ${courses[i].id} after fetch failure`, result.reason);
            return [];
          })
          .filter((event) => includeGenerated || !event.generatedFrom)
          .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

        log(
          "INFO",
          `get_calendar_events: Retrieved ${events.length} events across ${courses.length} courses` +
          (pendingCourseIds.length > 0 ? ` (${pendingCourseIds.length} pending sign-in)` : "")
        );

        // The response is always a bare array, pending sign-in or not — a
        // shape change would break every existing caller. A pending course
        // instead adds a second content block carrying the notice, which
        // names which course ids are unavailable.
        if (pendingCourseIds.length === 0) {
          return toolResponse(events);
        }
        return toolResponseWithNotice(
          events,
          "Sign-in to Brightspace is still in progress, so calendar events for " +
            `${pendingCourseIds.length} course(s) (${pendingCourseIds.join(", ")}) could not be fetched ` +
            `yet. ${authPendingNotice(firstAuthError)} Call get_calendar_events again once sign-in finishes.`
        );
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
