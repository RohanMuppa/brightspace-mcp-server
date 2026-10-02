/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register the study_planner prompt.
 *
 * `daysAhead` mirrors get_upcoming_due_dates' own argument (same name,
 * same default) so the window the user asks about and the window the
 * underlying tool call uses never drift apart.
 */
export function registerStudyPlannerPrompt(server: McpServer): void {
  server.registerPrompt(
    "study_planner",
    {
      title: "Study Planner",
      description:
        "Plan study time from upcoming due dates and calendar events over the next N days (default 7).",
      argsSchema: {
        daysAhead: z.coerce
          .number()
          .int()
          .min(1)
          .max(90)
          .default(7)
          .describe("Number of days ahead to plan for. Defaults to 7."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Build me a study plan for the next ${args.daysAhead} days. Call ` +
              `get_upcoming_due_dates with daysAhead: ${args.daysAhead} for assignments, quizzes, ` +
              `and discussion due dates, and get_calendar_events for the same window to pick up ` +
              "exams, labs, and other scheduled events. Group the work by day, put the heaviest or " +
              "most time-sensitive items earliest, leave a buffer day before anything that looks " +
              "like an exam, and call out any day with more due than looks reasonable to finish.",
          },
        },
      ],
    })
  );
}
