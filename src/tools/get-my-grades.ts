/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllItems } from "../api/paginate.js";
import {
  GetMyGradesSchema,
} from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { gradebookUrl } from "../utils/deep-links.js";
import type { AppConfig } from "../types/index.js";

interface GradeValue {
  GradeObjectIdentifier: string;
  GradeObjectName: string;
  DisplayedGrade: string;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  WeightedNumerator: number | null;
  WeightedDenominator: number | null;
  Comments: { Text: string; Html: string } | null;
  PrivateComments: { Text: string; Html: string } | null;
  LastModified: string;
  ReleasedDate: string | null;
}

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
 * Register get_my_grades tool
 */
export function registerGetMyGrades(
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
): void {
  server.registerTool(
    "get_my_grades",
    {
      title: "Get My Grades",
      description:
        "Fetch your grade breakdown for a specific course or all enrolled courses. Shows grade items with points, percentages, and comments. Use this when the user asks about grades, scores, marks, GPA, academic performance, or how they're doing in a class.",
      inputSchema: GetMyGradesSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_my_grades tool called", { args });

        // Parse and validate input
        const { courseId } = GetMyGradesSchema.parse(args);

        // Single course case
        if (courseId) {
          const path = apiClient.le(courseId, "/grades/values/myGradeValues/");
          let gradeValues: GradeValue[];
          try {
            gradeValues = await apiClient.get<GradeValue[]>(path, {
              ttl: DEFAULT_CACHE_TTLS.grades,
            });
          } catch (error: any) {
            // A 403 here means the tenant restricts the grade API for this
            // course (an institutional policy, not a bug). The error shape
            // stays the same plain isError text result every other tool
            // error uses -- only the text itself changes, naming the
            // gradebook URL so the student can see their grade there
            // instead.
            if (error?.status === 403) {
              const url = gradebookUrl(config.baseUrl, courseId);
              log("INFO", `get_my_grades: 403 for course ${courseId} - grade API access restricted`);
              return errorResponse(
                "Your institution restricts grade API access for this course. " +
                `View your grades directly in Brightspace: ${url}`
              );
            }
            throw error;
          }

          // Map to clean objects
          const grades = gradeValues.map((gv) => ({
            name: gv.GradeObjectName,
            displayGrade: gv.DisplayedGrade,
            pointsNumerator: gv.PointsNumerator,
            pointsDenominator: gv.PointsDenominator,
            weightedNumerator: gv.WeightedNumerator,
            weightedDenominator: gv.WeightedDenominator,
            comments: gv.Comments?.Text || null,
            lastModified: gv.LastModified,
          }));

          log("INFO", `get_my_grades: Retrieved ${grades.length} grade items for course ${courseId}`);
          return toolResponse({ courseId, grades });
        }

        // All courses case
        // First, fetch enrolled courses. isActive=true has to track the
        // configured policy rather than being pinned on: a user who set
        // activeOnly:false is asking to see archived courses, and a query that
        // withholds them leaves applyCourseFilter nothing to let through.
        const enrollmentPath = apiClient.lp(
          `/enrollments/myenrollments/?orgUnitTypeId=3${config.courseFilter.activeOnly ? "&isActive=true" : ""}`
        );
        // Enrollments arrive one page at a time; follow the bookmark chain so a
        // long enrollment history does not silently lose its later courses.
        const enrollmentItems = await fetchAllItems<EnrollmentItem>(
          apiClient,
          enrollmentPath,
          { ttl: DEFAULT_CACHE_TTLS.enrollments }
        );

        // Apply course filter
        const filteredEnrollments = applyCourseFilter(
          enrollmentItems.map(item => ({
            id: item.OrgUnit.Id,
            name: item.OrgUnit.Name,
            code: item.OrgUnit.Code,
            isActive: item.Access.IsActive,
            canAccess: item.Access.CanAccess,
            ...item,
          })),
          config.courseFilter
        );

        // Fetch grades for each course (handle 403s gracefully)
        const gradePromises = filteredEnrollments.map(async (item) => {
          try {
            const path = apiClient.le(
              item.OrgUnit.Id,
              "/grades/values/myGradeValues/"
            );
            const gradeValues = await apiClient.get<GradeValue[]>(path, {
              ttl: DEFAULT_CACHE_TTLS.grades,
            });

            const grades = gradeValues.map((gv) => ({
              name: gv.GradeObjectName,
              displayGrade: gv.DisplayedGrade,
              pointsNumerator: gv.PointsNumerator,
              pointsDenominator: gv.PointsDenominator,
              weightedNumerator: gv.WeightedNumerator,
              weightedDenominator: gv.WeightedDenominator,
              comments: gv.Comments?.Text || null,
              lastModified: gv.LastModified,
            }));

            return {
              restricted: false as const,
              courseId: item.OrgUnit.Id,
              courseName: item.OrgUnit.Name,
              grades,
            };
          } catch (error: any) {
            // A 403 means the tenant restricts the grade API for this course
            // (an institutional policy, not missing access like a dropped
            // past course). Rather than dropping the course with no trace,
            // it is surfaced in a separate, purely additive
            // `restrictedCourses` array; `courses` itself is unaffected.
            if (error?.status === 403) {
              log(
                "DEBUG",
                `get_my_grades: 403 Forbidden for course ${item.OrgUnit.Id} (${item.OrgUnit.Name}) - grade API access restricted`
              );
              return {
                restricted: true as const,
                courseId: item.OrgUnit.Id,
                courseName: item.OrgUnit.Name,
                gradeUrl: gradebookUrl(config.baseUrl, item.OrgUnit.Id),
              };
            }
            throw error; // Re-throw other errors
          }
        });

        const results = await Promise.allSettled(gradePromises);
        const settled = results
          .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
          .map((r) => r.value);
        const courses = settled
          .filter((r) => !r.restricted)
          .map(({ restricted: _restricted, ...rest }) => rest);
        const restrictedCourses = settled
          .filter((r) => r.restricted)
          .map(({ restricted: _restricted, ...rest }) => rest);

        log(
          "INFO",
          `get_my_grades: Retrieved grades for ${courses.length} courses, ` +
          `${restrictedCourses.length} restricted (out of ${enrollmentItems.length} enrolled)`
        );
        return toolResponse({ courses, restrictedCourses });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
