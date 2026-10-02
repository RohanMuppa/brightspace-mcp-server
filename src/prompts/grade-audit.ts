/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Register the grade_audit prompt.
 *
 * `courseId` is optional, same as the tools it drives (get_my_grades,
 * get_assignments): omitted, it audits every enrolled course at once.
 */
export function registerGradeAuditPrompt(server: McpServer): void {
  server.registerPrompt(
    "grade_audit",
    {
      title: "Grade Audit",
      description:
        "Analyze grades for one course or all of them, flagging missing, ungraded, or low-scoring items.",
      argsSchema: {
        courseId: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .describe("Course ID to audit. If omitted, audits every enrolled course."),
      },
    },
    async (args) => {
      const scope =
        args.courseId !== undefined
          ? `course ${args.courseId}`
          : "every enrolled course";
      const courseArg =
        args.courseId !== undefined ? `courseId: ${args.courseId}` : "no courseId (all courses)";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Audit my grades for ${scope}. Call get_my_grades with ${courseArg} and ` +
                `get_assignments with ${courseArg} and cross-reference them: flag any assignment ` +
                "or quiz with no grade posted yet, anything graded well below the class or my own " +
                "average, and any gradebook column from get_my_grades that matches no assignment " +
                "(a gradeOnly item, such as a proctored exam). If no courseId was given, first call " +
                "get_my_courses so you can label every finding with its course name, and summarize " +
                "per course before giving an overall picture.",
            },
          },
        ],
      };
    }
  );
}
