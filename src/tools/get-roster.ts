/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllObjects } from "../api/paginate.js";
import {
  GetRosterSchema,
} from "./schemas.js";
import { toolResponse, sanitizeError, isAuthUnavailable, authPendingNotice } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

export interface ClasslistUser {
  // D2L returns this as a string on real tenants even though it is
  // numeric-looking; callers that need to match it against a numeric id
  // (e.g. get_my_groups resolving Enrollments) must coerce with Number().
  Identifier: number | string;
  DisplayName: string;
  Email: string | null;
  FirstName: string | null;
  LastName: string | null;
  RoleId: number | null;
  ClasslistRoleDisplayName: string;
  IsOnline: boolean;
  LastAccessed: string | null;
}

// Purdue-specific role IDs. These are institution-specific values.
// If using at another institution, you may need to adjust these.
// Discover by fetching classlist for a known course and inspecting RoleId values.
const INSTRUCTOR_ROLE_ID = 109;
const TA_ROLE_ID = 135;

// When the role-ID fast path above returns nothing — a non-Purdue tenant
// where those IDs belong to different roles or none at all — staff are found
// instead by matching the role name the tenant itself reports. Role-name
// fallback adapted from matthewliu10/brightspace-mcp-server (MIT).
const TEACHING_ROLE_NAME =
  /\b(instructor|professor|lecturer|teaching assistant|coordinator|grader|ta)\b/i;

function isTeachingRoleByName(user: ClasslistUser): boolean {
  return TEACHING_ROLE_NAME.test(user.ClasslistRoleDisplayName ?? "");
}

/**
 * Fetch every classlist user matching the optional filters, across all pages.
 *
 * Exported so other tools that need names for a course's enrolled users
 * (e.g. get_my_groups resolving group membership) can reuse this instead of
 * re-implementing the paged classlist fetch.
 */
export async function fetchClasslistUsers(
  apiClient: D2LApiClient,
  courseId: number,
  options?: { roleId?: number; searchTerm?: string }
): Promise<ClasslistUser[]> {
  const params = new URLSearchParams();

  if (options?.roleId !== undefined) {
    params.append("roleId", options.roleId.toString());
  }

  if (options?.searchTerm) {
    params.append("searchTerm", options.searchTerm);
  }

  const queryString = params.toString();
  const path = apiClient.le(
    courseId,
    `/classlist/paged/${queryString ? "?" + queryString : ""}`
  );

  return fetchAllObjects<ClasslistUser>(apiClient, path, {
    ttl: DEFAULT_CACHE_TTLS.roster,
  });
}

/**
 * Register get_roster tool
 */
export function registerGetRoster(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_roster",
    {
      title: "Get Course Roster",
      description:
        "Fetch the roster for a course including instructors, TAs, and optionally students with their names, emails, and roles. Use this when the user asks about classmates, instructor contact info, TA emails, professor names, or who's in a class. By default returns only instructors and TAs for privacy. Use includeStudents to get full class list.",
      inputSchema: GetRosterSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_roster tool called", { args });

        // Parse and validate input
        const { courseId, includeStudents, searchTerm, limit } = GetRosterSchema.parse(args);

        try {
          const allUsers: ClasslistUser[] = [];
          let authFailure: PromiseRejectedResult | undefined;
          let roleFallbackUsed = false;

          if (!includeStudents) {
            // Fetch instructors and TAs in parallel
            const [instructorResult, taResult] = await Promise.allSettled([
              fetchClasslistUsers(apiClient, courseId, {
                roleId: INSTRUCTOR_ROLE_ID,
                searchTerm,
              }),
              fetchClasslistUsers(apiClient, courseId, {
                roleId: TA_ROLE_ID,
                searchTerm,
              }),
            ]);

            // A pending sign-in means that route can't be trusted to have
            // actually asked Brightspace anything — unlike a role group that
            // is genuinely empty, which is a real measurement. Note it rather
            // than quietly reporting half the roster as the whole answer, but
            // keep whichever route *did* answer instead of discarding it: a
            // roster that lost its TAs to a pending sign-in should still show
            // the instructor it already has.
            authFailure = [instructorResult, taResult].find(
              (r): r is PromiseRejectedResult =>
                r.status === "rejected" && isAuthUnavailable(r.reason)
            );

            // Merge results
            if (instructorResult.status === "fulfilled") {
              allUsers.push(...instructorResult.value);
            } else {
              log("WARN", "get_roster: Failed to fetch instructors", {
                error: instructorResult.reason,
              });
            }

            if (taResult.status === "fulfilled") {
              allUsers.push(...taResult.value);
            } else {
              log("WARN", "get_roster: Failed to fetch TAs", {
                error: taResult.reason,
              });
            }

            // Purdue's role IDs found nobody — on a non-Purdue tenant they
            // likely mean a different role, or none. Fall back to one
            // unfiltered classlist fetch and match on the role display name
            // the tenant itself reports instead of an institution-specific ID.
            // A genuine failure of this fetch is intentionally not caught
            // here: it should surface as a tool error rather than silently
            // producing an empty staff list.
            if (allUsers.length === 0) {
              const everyone = await fetchClasslistUsers(apiClient, courseId, {
                searchTerm,
              });
              allUsers.push(...everyone.filter(isTeachingRoleByName));
              roleFallbackUsed = true;
            }
          } else {
            // Fetch all users
            allUsers.push(
              ...(await fetchClasslistUsers(apiClient, courseId, { searchTerm }))
            );
          }

          // A very large roster would swamp the response, so it is capped. The
          // cap is reported in the payload rather than only in a log line the
          // model never sees: a 340 person lecture used to look like a 100
          // person one, with nothing to say otherwise.
          const total = allUsers.length;
          const truncated = total > limit;
          const kept = truncated ? allUsers.slice(0, limit) : allUsers;

          if (truncated) {
            log("WARN", "get_roster: Result set exceeds the limit, truncating", {
              total,
              returned: kept.length,
            });
          }

          // Map to clean output
          const users = kept.map((user) => ({
            name: user.DisplayName,
            email: user.Email || null,
            role: user.ClasslistRoleDisplayName,
          }));

          log(
            "INFO",
            `get_roster: Retrieved ${users.length} users for course ${courseId}` +
              (authFailure ? " (sign-in pending for one route)" : "")
          );
          return toolResponse({
            courseId,
            total,
            returned: users.length,
            truncated,
            ...(truncated
              ? { note: `Showing ${users.length} of ${total}. Raise the limit argument to see more.` }
              : {}),
            ...(roleFallbackUsed
              ? {
                  roleFilter:
                    "No users matched the default instructor/TA role IDs, so staff were found by matching role display names (instructor, professor, lecturer, teaching assistant, coordinator, grader, TA) instead.",
                }
              : {}),
            users,
            ...(authFailure
              ? {
                  authPending: true,
                  notice:
                    "Sign-in to Brightspace is still in progress, so part of the roster for this " +
                    `course could not be fetched yet. ${authPendingNotice(authFailure.reason)} Call ` +
                    "get_roster again once sign-in finishes.",
                }
              : {}),
          });
        } catch (error) {
          // A pending sign-in is not an empty roster: the route never
          // answered, so the result says so instead of reporting zero users
          // as if that were a real measurement. The envelope stays a success
          // — existing callers that only read `users` keep working — with
          // authPending/notice added for callers that want to tell "empty
          // roster" apart from "couldn't check".
          if (isAuthUnavailable(error)) {
            log("DEBUG", `get_roster: sign-in pending for course ${courseId}`, error);
            return toolResponse({
              courseId,
              total: 0,
              returned: 0,
              truncated: false,
              users: [],
              authPending: true,
              notice:
                "Sign-in to Brightspace is still in progress, so the roster for this course " +
                `could not be fetched yet. ${authPendingNotice(error)} Call get_roster again once ` +
                "sign-in finishes.",
            });
          }
          throw error;
        }
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
