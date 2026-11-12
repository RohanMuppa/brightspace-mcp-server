/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { ApiError } from "../api/errors.js";
import { GetAvailableGroupsSchema } from "./schemas.js";
import { toolResponse, toolResponseWithNotice, sanitizeError, isAuthUnavailable, authPendingNotice } from "./tool-helpers.js";
import { fetchCurrentUserId } from "./group-membership.js";
import { resolveCourses, type CourseRef } from "./resolve-courses.js";
import { log } from "../utils/logger.js";
import type { AppConfig } from "../types/index.js";

/** D2L's GRPENROLL_T values whose groups students pick themselves. */
const SELF_ENROLLMENT_STYLES = new Set([3, 4, 5]);
/** Without a courseId, courses that started longer ago than this are skipped unless includeOlder is set. */
const RECENT_COURSE_MS = 365 * 24 * 60 * 60 * 1000;

interface RichText { Text?: string | null; Html?: string | null }

interface GroupCategory {
  GroupCategoryId: number;
  Name: string;
  Description?: RichText | null;
  EnrollmentStyle: number;
  MaxUsersPerGroup?: number | null;
  DescriptionsVisibleToEnrolees?: boolean | null;
  SelfEnrollmentStartDate?: string | null;
  SelfEnrollmentExpiryDate?: string | null;
}

interface Group {
  GroupId: number;
  Name: string;
  Description?: RichText | null;
  Enrollments?: number[] | null;
}

interface OpenGroup {
  groupId: number;
  name: string;
  members: number;
  spotsLeft: number | null;
  description?: string;
}

interface OpenCategory {
  categoryId: number;
  name: string;
  description?: string;
  signUpCloses: string | null;
  maxPerGroup: number | null;
  groups: OpenGroup[];
}

interface CourseGroups {
  courseId: number;
  courseName: string | null;
  categories: OpenCategory[];
  /** Open sign-ups the user can't use because they already have a group there. */
  alreadyInGroup: Array<{ categoryId: number; name: string; groupName: string }>;
  unreadCategories?: string[];
}

const inaccessible = (error: unknown) => error instanceof ApiError && (error.status === 403 || error.status === 404);

const text = (value: RichText | null | undefined): string | undefined => value?.Text?.trim() || undefined;

/**
 * Brightspace shows a category on the "Available Groups" page while its
 * sign-up window is open; a missing start or expiry date leaves that side open.
 */
function signUpOpen(category: GroupCategory, now: number): boolean {
  if (!SELF_ENROLLMENT_STYLES.has(category.EnrollmentStyle)) return false;
  const start = category.SelfEnrollmentStartDate ? Date.parse(category.SelfEnrollmentStartDate) : -Infinity;
  const end = category.SelfEnrollmentExpiryDate ? Date.parse(category.SelfEnrollmentExpiryDate) : Infinity;
  return start <= now && now <= end;
}

async function fetchCourseGroups(apiClient: D2LApiClient, course: CourseRef, myId: number, now: number): Promise<CourseGroups> {
  const result: CourseGroups = { courseId: course.id, courseName: course.name, categories: [], alreadyInGroup: [] };
  let categories: GroupCategory[];
  try {
    categories = await apiClient.get<GroupCategory[]>(apiClient.lp(`/${course.id}/groupcategories/`), { ttl: DEFAULT_CACHE_TTLS.roster });
  } catch (error) {
    if (inaccessible(error)) return result;
    throw error;
  }

  const unread: string[] = [];
  for (const category of categories.filter((c) => signUpOpen(c, now))) {
    let groups: Group[];
    try {
      groups = await apiClient.get<Group[]>(
        apiClient.lp(`/${course.id}/groupcategories/${category.GroupCategoryId}/groups/`), { ttl: DEFAULT_CACHE_TTLS.roster });
    } catch (error) {
      if (inaccessible(error)) {
        unread.push(category.Name);
        continue;
      }
      throw error;
    }

    // Self-enrollment allows one group per category, as on the Available Groups page.
    const mine = groups.find((g) => g.Enrollments?.some((id) => Number(id) === myId));
    if (mine) {
      result.alreadyInGroup.push({ categoryId: category.GroupCategoryId, name: category.Name, groupName: mine.Name });
      continue;
    }

    const max = category.MaxUsersPerGroup ?? null;
    const showDescriptions = category.DescriptionsVisibleToEnrolees !== false;
    const open = groups
      .map((g): OpenGroup => {
        const members = g.Enrollments?.length ?? 0;
        const description = showDescriptions ? text(g.Description) : undefined;
        return {
          groupId: g.GroupId,
          name: g.Name,
          members,
          spotsLeft: max === null ? null : Math.max(0, max - members),
          ...(description ? { description } : {}),
        };
      })
      .filter((g) => g.spotsLeft === null || g.spotsLeft > 0);
    if (open.length === 0) continue;

    const description = text(category.Description);
    result.categories.push({
      categoryId: category.GroupCategoryId,
      name: category.Name,
      ...(description ? { description } : {}),
      signUpCloses: category.SelfEnrollmentExpiryDate ?? null,
      maxPerGroup: max,
      groups: open,
    });
  }
  if (unread.length > 0) result.unreadCategories = unread;
  return result;
}

/**
 * Register get_available_groups tool
 */
export function registerGetAvailableGroups(
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
): void {
  server.registerTool(
    "get_available_groups",
    {
      title: "Get Available Groups",
      annotations: { readOnlyHint: true },
      description:
        "List the groups the current user can still join themselves (self-enrollment), with spots left " +
        "and when sign-up closes. Use this when a student asks which project or lab groups are open. " +
        "This tool only reads; joining happens in Brightspace under Groups > Available Groups.",
      inputSchema: GetAvailableGroupsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_available_groups tool called", { args });
        const { courseId, includeOlder } = GetAvailableGroupsSchema.parse(args);
        const now = Date.now();
        const myId = await fetchCurrentUserId(apiClient);
        const enrolled = await resolveCourses(apiClient, config, courseId);
        // Some schools give courses a start date but never an end date and never
        // close them, so every past course still counts as active and its old
        // sign-ups without an expiry still look open. The start date is the only
        // signal of which courses are current.
        const courses = courseId || includeOlder ? enrolled : enrolled.filter((course) => {
          const start = course.startDate ? Date.parse(course.startDate) : NaN;
          return Number.isFinite(start) && start >= now - RECENT_COURSE_MS;
        });
        const olderSkipped = enrolled.length - courses.length;

        const results = await Promise.allSettled(courses.map((course) => fetchCourseGroups(apiClient, course, myId, now)));
        const pendingCourseIds: number[] = [];
        const failedCourseIds: number[] = [];
        let firstAuthError: unknown = null;
        const found = results.flatMap((result, i) => {
          if (result.status === "fulfilled") return [result.value];
          if (isAuthUnavailable(result.reason)) {
            if (courseId) throw result.reason;
            pendingCourseIds.push(courses[i].id);
            firstAuthError ??= result.reason;
          } else {
            if (courseId) throw result.reason;
            failedCourseIds.push(courses[i].id);
            log("DEBUG", "get_available_groups: skipping course after fetch failure", result.reason);
          }
          return [];
        });

        // A course with nothing open is left out so the list stays about choices.
        const withChoices = found.filter((c) => c.categories.length > 0 || c.alreadyInGroup.length > 0 || c.unreadCategories);
        const openGroups = withChoices.reduce((n, c) => n + c.categories.reduce((m, cat) => m + cat.groups.length, 0), 0);
        log("INFO", `get_available_groups: ${openGroups} open groups across ${courses.length} course(s)`);

        const notes: string[] = [];
        if (withChoices.length === 0) notes.push("No group sign-ups are open in these courses right now.");
        if (olderSkipped > 0) {
          notes.push(`Checked the courses that started in the last 12 months; pass includeOlder: true to also check the other ${olderSkipped}.`);
        }
        if (failedCourseIds.length > 0) {
          notes.push(`Couldn't read groups for course(s) ${failedCourseIds.join(", ")}, so open sign-ups there aren't listed.`);
        }
        // Without a reason attached, a bare unreadCategories list reads like a
        // category with nothing open, so name each one and say why it's there.
        const unread = withChoices.filter((c) => c.unreadCategories);
        if (unread.length > 0) {
          const where = unread
            .map((c) => `${c.unreadCategories!.map((name) => `"${name}"`).join(", ")} in course ${c.courseId}`)
            .join("; ");
          notes.push(
            `Couldn't read the groups in the open sign-up(s) ${where}, so any open groups there aren't listed ` +
            "(see unreadCategories). Don't report them as full or closed; check Groups > Available Groups in Brightspace."
          );
        }
        const data = {
          coursesChecked: courses.length,
          courses: withChoices,
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
          ...(pendingCourseIds.length > 0 ? { authPending: true, unavailableCourseIds: pendingCourseIds } : {}),
        };
        return pendingCourseIds.length > 0
          ? toolResponseWithNotice(data, authPendingNotice(firstAuthError))
          : toolResponse(data);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
