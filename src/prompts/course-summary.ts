/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register the course_summary prompt.
 *
 * `courseId` is required — unlike the other three prompts this one is
 * always about exactly one course, so there is no sensible "all courses"
 * fallback the way get_my_grades or get_assignments have.
 */
export function registerCourseSummaryPrompt(server: McpServer): void {
  server.registerPrompt(
    "course_summary",
    {
      title: "Course Summary",
      description:
        "A one-course rollup: syllabus, content outline, assignments, and current grades.",
      argsSchema: {
        courseId: z.coerce
          .number()
          .int()
          .positive()
          .describe("Course ID to summarize."),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Give me a summary of course ${args.courseId}. Call get_syllabus for the course ` +
              `description and policies, get_course_content for the module and topic outline, ` +
              `get_assignments for what's assigned and its due dates and submission status, and ` +
              `get_my_grades for where I currently stand. Pull it together into one summary: what ` +
              "the course covers, how it's structured, what's outstanding, and how my grades look " +
              "so far.",
          },
        },
      ],
    })
  );
}
