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
import { toolResponse, sanitizeError } from "./tool-helpers.js";
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
        const courses = applyCourseFilter(
          items.map((item) => ({
            id: item.OrgUnit.Id,
            name: item.OrgUnit.Name,
            code: item.OrgUnit.Code,
            role: item.Access.ClasslistRoleName,
            isActive: item.Access.IsActive,
            canAccess: item.Access.CanAccess,
            lastAccessed: item.Access.LastAccessed,
          })),
          { ...config.courseFilter, activeOnly }
        );

        log("INFO", `get_my_courses: Retrieved ${courses.length} courses`);
        return toolResponse(courses);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
