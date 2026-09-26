/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllItems } from "../api/paginate.js";
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
    IsActive: boolean;
    CanAccess?: boolean;
  };
}

export interface CourseRef {
  id: number;
  name: string | null;
}

/**
 * Resolve which courses to query, and their names.
 *
 * A tool-level courseId bypasses the configured course filter, but enrollments
 * are still fetched so the course can be named.
 */
export async function resolveCourses(
  apiClient: D2LApiClient,
  config: AppConfig,
  courseId?: number
): Promise<CourseRef[]> {
  let items: EnrollmentItem[] = [];

  try {
    // isActive=true tracks the configured policy rather than being pinned on:
    // a user who set activeOnly:false is asking to see archived courses, and a
    // query that withholds them leaves applyCourseFilter nothing to let
    // through. Enrollments are paged, so follow the bookmark chain — a long
    // enrollment history would otherwise lose every course past the first page,
    // and every deadline in those courses with it.
    items = await fetchAllItems<EnrollmentItem>(
      apiClient,
      apiClient.lp(
        `/enrollments/myenrollments/?orgUnitTypeId=3${config.courseFilter.activeOnly ? "&isActive=true" : ""}`
      ),
      { ttl: DEFAULT_CACHE_TTLS.enrollments }
    );
  } catch (error) {
    // Without enrollments there is no course list to walk, so only the explicit
    // single-course case can continue (with an unnamed course).
    if (!courseId) throw error;
    log("DEBUG", "resolveCourses: could not fetch enrollments for course name", error);
  }

  if (courseId) {
    const match = items.find((item) => item.OrgUnit.Id === courseId);
    return [{ id: courseId, name: match?.OrgUnit.Name ?? null }];
  }

  const filtered = applyCourseFilter(
    items.map((item) => ({
      id: item.OrgUnit.Id,
      name: item.OrgUnit.Name,
      code: item.OrgUnit.Code,
      isActive: item.Access.IsActive,
            canAccess: item.Access.CanAccess,
    })),
    config.courseFilter
  );

  return filtered.map((course) => ({ id: course.id, name: course.name }));
}
