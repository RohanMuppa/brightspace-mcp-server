/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllItems } from "../api/paginate.js";
import {
  GetMyCoursesSchema,
} from "./schemas.js";
import { toolResponse, toolResponseWithNotice, sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import type { AppConfig } from "../types/index.js";

interface EnrollmentItem {
  OrgUnit: {
    Id: number;
    Name: string;
    Code: string;
  };
  Access: {
    ClasslistRoleName: string;
    IsActive: boolean;
    CanAccess?: boolean;
    StartDate: string | null;
    EndDate: string | null;
    LastAccessed: string | null;
  };
}

/**
 * Register get_my_courses tool
 */
export function registerGetMyCourses(
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
): void {
  server.registerTool(
    "get_my_courses",
    {
      title: "Get My Courses",
      annotations: { readOnlyHint: true },
      description:
        "Fetch your enrolled Brightspace courses with names, codes, and IDs. Use this when the user asks about their courses, enrolled classes, what they're taking this semester, or needs a course ID for other queries.",
      inputSchema: GetMyCoursesSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_my_courses tool called", { args });

        // Parse and validate input
        const { activeOnly: activeOnlyArg } = GetMyCoursesSchema.parse(args);

        // An explicit per-call argument wins; otherwise fall back to the configured
        // policy. Resolving once here keeps the API query and the post-fetch filter
        // in agreement — previously the argument shaped the query but the filter
        // still used config.courseFilter.activeOnly, so activeOnly:false fetched
        // inactive courses and then discarded them.
        const activeOnly = activeOnlyArg ?? config.courseFilter.activeOnly;

        // Build path - orgUnitTypeId=3 means "Course Offering" type
        const path = apiClient.lp(
          `/enrollments/myenrollments/?orgUnitTypeId=3${activeOnly ? "&isActive=true" : ""}`
        );

        // Fetch enrollments, following the bookmark chain to the last page
        const items = await fetchAllItems<EnrollmentItem>(apiClient, path, {
          ttl: DEFAULT_CACHE_TTLS.enrollments,
        });

        // Map to clean objects and apply course filter
        const enrolled = items.map((item) => ({
          id: item.OrgUnit.Id,
          name: item.OrgUnit.Name,
          code: item.OrgUnit.Code,
          role: item.Access.ClasslistRoleName,
          isActive: item.Access.IsActive,
          canAccess: item.Access.CanAccess,
          startDate: item.Access.StartDate,
          endDate: item.Access.EndDate,
          lastAccessed: item.Access.LastAccessed,
        }));
        const courses = applyCourseFilter(enrolled, { ...config.courseFilter, activeOnly });

        log("INFO", `get_my_courses: Retrieved ${courses.length} courses`);

        // The caller can lift activeOnly with the argument above, but not the
        // other course settings, and the agent never sees those settings. A
        // course they hide must not read as one the student is not in (#484).
        const notice = settingsHiddenNotice(enrolled, courses, activeOnly, config);
        return notice ? toolResponseWithNotice(courses, notice) : toolResponse(courses);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}

/**
 * A notice naming the courses that D2L_CURRENT_ONLY, D2L_INCLUDE_COURSES or
 * D2L_EXCLUDE_COURSES removed, or null when those settings removed none.
 * Courses dropped by activeOnly alone are not counted: the caller chose that
 * and can lift it with activeOnly:false.
 */
function settingsHiddenNotice(
  enrolled: Parameters<typeof applyCourseFilter>[0],
  shown: Array<{ id: number }>,
  activeOnly: boolean,
  config: AppConfig
): string | null {
  const { currentOnly, includeCourseIds, excludeCourseIds } = config.courseFilter;
  const settings: string[] = [];
  if (currentOnly) settings.push("D2L_CURRENT_ONLY");
  if (includeCourseIds && includeCourseIds.length > 0) settings.push("D2L_INCLUDE_COURSES");
  if (excludeCourseIds && excludeCourseIds.length > 0) settings.push("D2L_EXCLUDE_COURSES");
  if (settings.length === 0) return null;

  const shownIds = new Set(shown.map((course) => course.id));
  const hiddenIds = applyCourseFilter(enrolled, { activeOnly })
    .map((course) => course.id)
    .filter((id) => !shownIds.has(id));
  if (hiddenIds.length === 0) return null;

  const are = hiddenIds.length === 1 ? "course is" : "courses are";
  return (
    `${hiddenIds.length} enrolled ${are} hidden by this server's course settings ` +
    `(${settings.join(", ")}), so not listed: ${hiddenIds.join(", ")}. Do not tell the user they ` +
    "are not enrolled in a course missing from this list. Other tools still read a hidden course " +
    "when given its courseId."
  );
}
