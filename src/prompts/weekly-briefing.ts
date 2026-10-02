/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Register the weekly_briefing prompt.
 *
 * Takes no arguments: it asks for a rolled-up status of the coming week
 * across every enrolled course, which is exactly the kind of thing a user
 * opens their client just to ask, every Monday, without typing it out.
 */
export function registerWeeklyBriefingPrompt(server: McpServer): void {
  server.registerPrompt(
    "weekly_briefing",
    {
      title: "Weekly Briefing",
      description:
        "A 7-day rollup of what's due, what's new, and what's changed in grades across every enrolled course.",
      // No argsSchema: this prompt takes no arguments. An empty `argsSchema: {}`
      // would make the SDK validate `request.params.arguments` against
      // z.object({}), which rejects a GetPrompt call that omits `arguments`
      // entirely (some MCP clients do). Omitting argsSchema takes the SDK's
      // no-args path instead, which accepts both a missing and an empty
      // `arguments` field.
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Give me a briefing for the next 7 days across all my Brightspace courses. " +
              "Use get_upcoming_due_dates (daysAhead: 7) for what's due, get_calendar_events " +
              "(the next 7 days) for exams, labs, and other scheduled events, " +
              "get_announcements (modifiedSince: 7 days ago) for anything new course staff " +
              "posted, and get_my_grades to call out any grade that changed or any item that " +
              "newly posted a score. Organize the result by course, lead with anything due in " +
              "the next 48 hours, and flag announcements or grade changes that need a reply or " +
              "a decision from me.",
          },
        },
      ],
    })
  );
}
