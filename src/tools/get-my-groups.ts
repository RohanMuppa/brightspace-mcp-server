/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { ApiError } from "../api/errors.js";
import { GetMyGroupsSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { fetchClasslistUsers, type ClasslistUser } from "./get-roster.js";
import { log } from "../utils/logger.js";
import { fetchMyGroupMemberships } from "./group-membership.js";

interface GroupMember {
  userId: number;
  name: string | null;
}

interface MyGroup {
  categoryId: number;
  categoryName: string;
  groupId: number;
  groupName: string;
  groupCode?: string;
  members: GroupMember[];
}

/** True when a group/category endpoint simply isn't there for this course or user. */
function isMissingOrForbidden(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
}

/**
 * Register get_my_groups tool
 */
export function registerGetMyGroups(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_my_groups",
    {
      title: "Get My Groups",
      annotations: { readOnlyHint: true },
      description:
        "List the current user's project/discussion groups in a course, with each group's members. " +
        "Use this when a student asks who is in their project group, lab group, or discussion group.",
      inputSchema: GetMyGroupsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_my_groups tool called", { args });

        const { courseId } = GetMyGroupsSchema.parse(args);

        const { matches, categoriesUnavailable } = await fetchMyGroupMemberships(apiClient, courseId);
        if (categoriesUnavailable) {
          return toolResponse({
            courseId,
            groups: [],
            note: "No groups are visible for this course (it may not use groups, or group info isn't accessible).",
          });
        }

        if (matches.length === 0) {
          log("INFO", `get_my_groups: User is not a member of any group in course ${courseId}`);
          return toolResponse({
            courseId,
            groups: [],
            note: "Group categories exist for this course, but the current user is not a member of any group.",
          });
        }

        // Best-effort classlist for member names. A course where the current
        // user lacks classlist access still returns groups, just with
        // member names left null instead of failing the whole request.
        // Identifier comes back from D2L as a string on real tenants, even
        // though it looks numeric, so it must be coerced before it can be
        // used as a key alongside the numeric Enrollments ids.
        let classlistById = new Map<number, ClasslistUser>();
        try {
          const classlist = await fetchClasslistUsers(apiClient, courseId);
          classlistById = new Map(classlist.map((u) => [Number(u.Identifier), u]));
        } catch (error) {
          if (isMissingOrForbidden(error)) {
            log("INFO", "get_my_groups: Classlist not accessible, member names will be null", { courseId });
          } else {
            throw error;
          }
        }

        const groups: MyGroup[] = matches.map(({ category, group }) => {
          const enrollments = group.Enrollments ?? [];
          const members: GroupMember[] = enrollments.map((userId) => ({
            userId,
            name: classlistById.get(userId)?.DisplayName ?? null,
          }));

          return {
            categoryId: category.GroupCategoryId,
            categoryName: category.Name,
            groupId: group.GroupId,
            groupName: group.Name,
            ...(group.Code ? { groupCode: group.Code } : {}),
            members,
          };
        });

        log("INFO", `get_my_groups: Found ${groups.length} groups for course ${courseId}`);
        return toolResponse({ courseId, groups });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
