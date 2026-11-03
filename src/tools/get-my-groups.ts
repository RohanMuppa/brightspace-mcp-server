/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient } from "../api/index.js";
import { ApiError } from "../api/errors.js";
import { GetMyGroupsSchema } from "./schemas.js";
import { toolResponse, sanitizeError, isAuthUnavailable } from "./tool-helpers.js";
import { fetchClasslistUsers, type ClasslistUser } from "./get-roster.js";
import { log } from "../utils/logger.js";
import { fetchMyGroupMemberships } from "./group-membership.js";
import { decodeEntities } from "../utils/html-attributes.js";

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
  /** Names from the group's "View Members" page, in Brightspace's order; not paired with the ids. */
  memberNames?: string[];
}

/**
 * Names on a group's "View Members" page (group_member_list.d2l), or null when
 * the page doesn't have the member table. Each data row holds one name in a
 * single cell; the header row is the only one with a class.
 */
export function memberNamesFromPage(html: string): string[] | null {
  const table = /<table\b[^>]*\bd2l-grid\b[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!table) return null;
  const names: string[] = [];
  for (const row of table[1].matchAll(/<tr>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)) {
    const name = decodeEntities(row[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (name) names.push(name);
  }
  return names;
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

        const { matches, categoriesUnavailable, unreadCategories } = await fetchMyGroupMemberships(apiClient, courseId);
        if (categoriesUnavailable) {
          return toolResponse({
            courseId,
            groups: [],
            note: "No groups are visible for this course (it may not use groups, or group info isn't accessible).",
          });
        }

        const unreadNote = unreadCategories.length === 0 ? undefined
          : `Couldn't read the groups in ${unreadCategories.map((c) => `"${c.Name || c.GroupCategoryId}"`).join(", ")}, ` +
            "so any group the current user has there is not listed.";
        if (unreadNote) {
          log("INFO", "get_my_groups: Some group categories could not be read", {
            courseId,
            categoryIds: unreadCategories.map((c) => c.GroupCategoryId),
          });
        }

        if (matches.length === 0 && unreadNote) {
          return toolResponse({ courseId, groups: [], note: unreadNote });
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
        let namesUnavailable = false;
        try {
          const classlist = await fetchClasslistUsers(apiClient, courseId);
          classlistById = new Map(classlist.map((u) => [Number(u.Identifier), u]));
        } catch (error) {
          if (isMissingOrForbidden(error)) {
            log("INFO", "get_my_groups: Classlist not accessible, member names will be null", { courseId });
            namesUnavailable = true;
          } else {
            throw error;
          }
        }

        // Students who can't read the classlist can still open each of their
        // groups' "View Members" page, so read the names from there. The page
        // carries no user ids, so the names stay a separate list.
        const pageNames = new Map<number, string[]>();
        if (namesUnavailable) {
          for (const { group } of matches) {
            try {
              const html = await apiClient.getPage(
                `/d2l/lms/group/group_member_list.d2l?ou=${courseId}&groupId=${group.GroupId}`
              );
              const names = html === null ? null : memberNamesFromPage(html);
              if (names) pageNames.set(group.GroupId, names);
            } catch (error) {
              if (isAuthUnavailable(error)) throw error;
              log("DEBUG", `get_my_groups: Couldn't read the member page for group ${group.GroupId}`, error);
            }
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
            ...(pageNames.has(group.GroupId) ? { memberNames: pageNames.get(group.GroupId) } : {}),
          };
        });

        log("INFO", `get_my_groups: Found ${groups.length} groups for course ${courseId}`);
        // Null names are only meaningful with a reason attached: without one,
        // a caller can't tell "the classlist couldn't be read" from "these
        // members have no names", and may report the group as anonymous.
        const namesNote = !namesUnavailable ? undefined
          : pageNames.size === matches.length
            ? "Couldn't read this course's classlist, so member names are null; memberNames lists each group's " +
              "members from its member page, which doesn't say which name belongs to which user id."
            : "Couldn't read this course's classlist, so member names are null; only user ids are listed" +
              (pageNames.size > 0 ? ", except where memberNames lists a group's members from its member page." : ".");
        const note = [unreadNote, namesNote].filter(Boolean).join(" ") || undefined;
        return toolResponse({ courseId, groups, ...(note ? { note } : {}) });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
