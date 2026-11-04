/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllObjects } from "../api/paginate.js";
import { GetClasslistEmailsSchema } from "./schemas.js";
import { toolResponse, toolResponseWithNotice, sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

interface ClasslistUser {
  Identifier: number;
  DisplayName: string;
  Email: string | null;
  ClasslistRoleDisplayName: string;
}

/**
 * Register get_classlist_emails tool
 */
export function registerGetClasslistEmails(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_classlist_emails",
    {
      title: "Get Classlist Emails",
      annotations: { readOnlyHint: true },
      description:
        "Fetch all email addresses for everyone in a course — instructors, TAs, and students. " +
        "Use this when the user wants a list of emails for a class, needs to email the whole class, " +
        "or wants contact info for everyone enrolled.",
      inputSchema: GetClasslistEmailsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_classlist_emails tool called", { args });

        const { courseId } = GetClasslistEmailsSchema.parse(args);

        // Fetch full classlist (all roles) using paged endpoint
        const path = apiClient.le(courseId, "/classlist/paged/");
        const users = await fetchAllObjects<ClasslistUser>(apiClient, path, {
          ttl: DEFAULT_CACHE_TTLS.roster,
        });

        // Extract emails, filtering out nulls (privacy-hidden)
        const emails = users
          .filter((user) => user.Email)
          .map((user) => ({
            name: user.DisplayName,
            email: user.Email,
            role: user.ClasslistRoleDisplayName,
          }));

        log("INFO", `get_classlist_emails: ${emails.length} emails from ${users.length} users in course ${courseId}`);

        // People whose email Brightspace hides are left out of the list. Say
        // so, or a partial list reads as the whole class and an all-hidden
        // course reads as an empty one.
        const hidden = users.length - emails.length;
        if (hidden > 0) {
          const who = hidden === 1 ? "person" : "people";
          const has = hidden === 1 ? "has" : "have";
          return toolResponseWithNotice(
            emails,
            `${hidden} of ${users.length} ${who} in this course ${has} no email visible to you ` +
            `(Brightspace hides it), so they are not listed.`
          );
        }
        return toolResponse(emails);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
