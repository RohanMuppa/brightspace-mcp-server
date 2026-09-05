/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import {
  GetMyGradesSchema,
} from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { applyCourseFilter } from "../utils/course-filter.js";
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

interface EnrollmentResponse {
  Items: EnrollmentItem[];
  PagingInfo?: {
    HasMoreItems: boolean;
    Bookmark?: string;
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
          const gradeValues = await apiClient.get<GradeValue[]>(path, {
            ttl: DEFAULT_CACHE_TTLS.grades,
          });

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
        // First, fetch enrolled courses
        const enrollmentPath = apiClient.lp(
          "/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true"
        );
        const enrollmentResponse = await apiClient.get<EnrollmentResponse>(
          enrollmentPath,
          { ttl: DEFAULT_CACHE_TTLS.enrollments }
        );

        // Apply course filter
        const filteredEnrollments = applyCourseFilter(
          enrollmentResponse.Items.map(item => ({
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
              courseId: item.OrgUnit.Id,
              courseName: item.OrgUnit.Name,
              grades,
            };
          } catch (error: any) {
            // 403 means no access (past course, etc) - log and skip
            if (error?.status === 403) {
              log(
                "DEBUG",
                `get_my_grades: 403 Forbidden for course ${item.OrgUnit.Id} (${item.OrgUnit.Name}) - skipping`
              );
              return null;
            }
            throw error; // Re-throw other errors
          }
        });

        const results = await Promise.allSettled(gradePromises);
        const courses = results
          .filter(
            (r): r is PromiseFulfilledResult<any> =>
              r.status === "fulfilled" && r.value !== null
          )
          .map((r) => r.value);

        log(
          "INFO",
          `get_my_grades: Retrieved grades for ${courses.length} courses (out of ${enrollmentResponse.Items.length} enrolled)`
        );
        return toolResponse({ courses });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
