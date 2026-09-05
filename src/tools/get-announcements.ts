/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import {
  GetAnnouncementsSchema,
} from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import type { AppConfig } from "../types/index.js";

interface NewsItem {
  Id: number;
  Title: string;
  Body: { Text: string; Html: string } | null;
  CreatedBy: { Identifier: string; DisplayName: string } | null;
  CreatedDate: string | null;
  LastModifiedBy: { Identifier: string; DisplayName: string };
  LastModifiedDate: string;
  StartDate: string | null;
  EndDate: string | null;
  IsPublished?: boolean;
  IsPinned: boolean;
  IsGlobal: boolean;
  Attachments: any[];
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
 * A date the runtime can actually order, or null. Unreadable and absent are the
 * same answer, so a caller can fall through to the next best.
 */
function readableDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return Number.isNaN(new Date(raw).getTime()) ? null : raw;
}

/**
 * The date a post was actually scheduled for. StartDate is when the instructor
 * scheduled it, which is the honest date whenever there is one; CreatedDate is
 * the fallback for a post nobody scheduled.
 */
export function effectiveDate(item: NewsItem): string | null {
  return readableDate(item.StartDate) ?? readableDate(item.CreatedDate);
}

/**
 * False only for a draft the instructor has not posted. The test is an explicit
 * false, never a falsy read: an item that omits the field is a shape the tenant
 * has never sent, and treating unknown as unpublished would empty the section
 * the day D2L renames or drops the field.
 */
export function isPublishedNewsItem(item: NewsItem): boolean {
  return item.IsPublished !== false;
}

/**
 * Newest first by the scheduled date, undated last. An undated item sorts to
 * the end rather than to 1970, where a null read as an epoch would put it:
 * ahead of nothing, but behind everything real. Equal dates return 0 and keep
 * the server's own order, which is what makes the slice deterministic when a
 * course posts twice in one minute.
 */
export function newestFirst(
  a: { date: string | null },
  b: { date: string | null }
): number {
  if (a.date === b.date) return 0;
  if (a.date === null) return 1;
  if (b.date === null) return -1;
  return new Date(b.date).getTime() - new Date(a.date).getTime();
}

/**
 * Map a raw D2L news item to a clean announcement object.
 */
export function mapNewsItem(item: NewsItem) {
  return {
    id: item.Id,
    title: item.Title,
    body: item.Body?.Text ?? "",
    createdBy: item.CreatedBy?.DisplayName ?? "Unknown",
    createdDate: item.CreatedDate,
    startDate: item.StartDate,
    date: effectiveDate(item),
    isPinned: item.IsPinned,
  };
}

/**
 * Register get_announcements tool
 */
export function registerGetAnnouncements(
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
): void {
  server.registerTool(
    "get_announcements",
    {
      title: "Get Announcements",
      description:
        "Fetch recent announcements from your courses. Can filter to a specific course or get announcements across all courses. Use this when the user asks about announcements, news, updates from instructors, recent posts, or what professors said.",
      inputSchema: GetAnnouncementsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_announcements tool called", { args });

        // Parse and validate input
        const { courseId, count } = GetAnnouncementsSchema.parse(args);

        // Single course case
        if (courseId) {
          const path = apiClient.le(courseId, "/news/");
          const newsItems = await apiClient.get<NewsItem[]>(path, {
            ttl: DEFAULT_CACHE_TTLS.announcements,
          });

          // Drop drafts, then map to clean objects
          const announcements = newsItems
            .filter(isPublishedNewsItem)
            .map(mapNewsItem)
            .sort(newestFirst)
            .slice(0, count);

          log(
            "INFO",
            `get_announcements: Retrieved ${announcements.length} announcements for course ${courseId}`
          );
          return toolResponse(announcements);
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

        // Fetch announcements for each course (handle 403s gracefully)
        const announcementPromises = filteredEnrollments.map(
          async (item) => {
            try {
              const path = apiClient.le(item.OrgUnit.Id, "/news/");
              const newsItems = await apiClient.get<NewsItem[]>(path, {
                ttl: DEFAULT_CACHE_TTLS.announcements,
              });

              return newsItems
                .filter(isPublishedNewsItem)
                .map((newsItem) => ({
                  ...mapNewsItem(newsItem),
                  courseId: item.OrgUnit.Id,
                  courseName: item.OrgUnit.Name,
                }));
            } catch (error: any) {
              // 403 means no access (past course, etc) - log and skip
              if (error?.status === 403) {
                log(
                  "DEBUG",
                  `get_announcements: 403 Forbidden for course ${item.OrgUnit.Id} (${item.OrgUnit.Name}) - skipping`
                );
                return [];
              }
              throw error; // Re-throw other errors
            }
          }
        );

        const results = await Promise.allSettled(announcementPromises);
        const allAnnouncements = results
          .filter(
            (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled"
          )
          .flatMap((r) => r.value);

        // Sort by the scheduled date and slice to count
        const announcements = allAnnouncements
          .sort(newestFirst)
          .slice(0, count);

        log(
          "INFO",
          `get_announcements: Retrieved ${announcements.length} announcements (out of ${allAnnouncements.length} total across ${enrollmentResponse.Items.length} courses)`
        );
        return toolResponse(announcements);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
