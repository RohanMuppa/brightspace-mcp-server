/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { GetCalendarEventsSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
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

        const courses = await resolveCourses(apiClient, config, courseId);

        const results = await Promise.allSettled(
          courses.map((course) =>
            fetchCourseCalendarEvents(apiClient, config.baseUrl, course, windowStart, windowEnd)
          )
        );

        const events = results
          .flatMap((result, i) => {
            if (result.status === "fulfilled") return result.value;
            log("DEBUG", `get_calendar_events: skipping course ${courses[i].id} after fetch failure`, result.reason);
            return [];
          })
          .filter((event) => includeGenerated || !event.generatedFrom)
          .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

        log("INFO", `get_calendar_events: Retrieved ${events.length} events across ${courses.length} courses`);
        return toolResponse(events);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
