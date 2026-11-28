/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllItems } from "../api/paginate.js";
import { log } from "../utils/logger.js";
import { applyCourseFilter, coursesHiddenBySettings, type SettingsHiddenCourses } from "../utils/course-filter.js";
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
    StartDate: string | null;
    EndDate: string | null;
  };
}

export interface CourseRef {
  id: number;
  name: string | null;
  /** The enrollment's access start, when Brightspace has one. */
  startDate?: string | null;
}

export interface ResolvedCourses {
  courses: CourseRef[];
  /**
   * Enrolled courses that D2L_CURRENT_ONLY, D2L_INCLUDE_COURSES or
   * D2L_EXCLUDE_COURSES removed, or null when they removed none. Always null
   * for a tool-level courseId, which bypasses those settings.
   */
  hidden: SettingsHiddenCourses | null;
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
  return (await resolveCoursesWithHidden(apiClient, config, courseId)).courses;
}

/**
 * resolveCourses, plus which enrolled courses the course settings hid.
 *
 * **Why:** the agent never sees those settings, so a hidden course read as one
 * with nothing due (#492), no calendar events (#496) or no open groups (#499).
 */
export async function resolveCoursesWithHidden(
  apiClient: D2LApiClient,
  config: AppConfig,
  courseId?: number
): Promise<ResolvedCourses> {
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
    return {
      courses: [{ id: courseId, name: match?.OrgUnit.Name ?? null, startDate: match?.Access.StartDate ?? null }],
      hidden: null,
    };
  }

  const enrolled = items.map((item) => ({
    id: item.OrgUnit.Id,
    name: item.OrgUnit.Name,
    code: item.OrgUnit.Code,
    isActive: item.Access.IsActive,
    canAccess: item.Access.CanAccess,
    startDate: item.Access.StartDate,
    endDate: item.Access.EndDate,
  }));
  const filtered = applyCourseFilter(enrolled, config.courseFilter);

  return {
    courses: filtered.map((course) => ({ id: course.id, name: course.name, startDate: course.startDate })),
    hidden: coursesHiddenBySettings(enrolled, filtered, config.courseFilter),
  };
}
