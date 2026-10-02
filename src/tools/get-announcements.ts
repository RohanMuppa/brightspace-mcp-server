/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllItems } from "../api/paginate.js";
import {
  GetAnnouncementsSchema,
} from "./schemas.js";
import { toolResponse, toolResponseWithNotice, sanitizeError, isAuthUnavailable, authPendingNotice } from "./tool-helpers.js";
import { log } from "../utils/logger.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { matchesModifiedSince } from "../utils/modified-since.js";
import type { AppConfig } from "../types/index.js";

export interface NewsItem {
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
  Attachments?: Array<{ FileId: number; FileName: string; Size: number }> | null;
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
    StartDate: string | null;
    EndDate: string | null;
    LastAccessed: string | null;
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
 * Fetch the raw news items for a course. Shared with search_course so both
 * tools hit the same endpoint (and cache entry) instead of duplicating it.
 */
export async function fetchCourseNews(
  apiClient: D2LApiClient,
  courseId: number
): Promise<NewsItem[]> {
  return apiClient.get<NewsItem[]>(apiClient.le(courseId, "/news/"), {
    ttl: DEFAULT_CACHE_TTLS.announcements,
  });
}

/**
 * Map a raw D2L news item to a clean announcement object.
 */
export function mapNewsItem(item: NewsItem) {
  const attachments = (item.Attachments ?? []).map((file) => ({
    fileId: file.FileId,
    fileName: file.FileName,
    size: file.Size,
  }));
  return {
    id: item.Id,
    title: item.Title,
    body: item.Body?.Text ?? "",
    createdBy: item.CreatedBy?.DisplayName ?? "Unknown",
    date: effectiveDate(item),
    isPinned: item.IsPinned,
    lastModified: item.LastModifiedDate ?? null,
    ...(attachments.length > 0 ? { attachments } : {}),
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
        "Fetch recent announcements from your courses. Can filter to a specific course or get announcements across all courses. Use this when the user asks about announcements, news, updates from instructors, recent posts, or what professors said. Attachments are listed per announcement; fetch them with download_file (newsId + fileId) or read them with get_announcement_files.",
      inputSchema: GetAnnouncementsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_announcements tool called", { args });

        // Parse and validate input
        const { courseId, count, modifiedSince } = GetAnnouncementsSchema.parse(args);
        const cutoff = modifiedSince ? new Date(modifiedSince) : null;

        // Single course case
        if (courseId) {
          try {
            const newsItems = await fetchCourseNews(apiClient, courseId);

            // Drop drafts, then map to clean objects
            const published = newsItems.filter(isPublishedNewsItem).map(mapNewsItem);
            const matched = cutoff
              ? published.filter((a) => matchesModifiedSince(a.lastModified, cutoff))
              : published;
            const announcements = matched.sort(newestFirst).slice(0, count);

            log(
              "INFO",
              `get_announcements: Retrieved ${announcements.length} announcements for course ${courseId}`
            );
            return toolResponse(
              modifiedSince
                ? {
                    announcements,
                    modifiedSince,
                    returned: announcements.length,
                    filteredOut: published.length - matched.length,
                  }
                : announcements
            );
          } catch (error) {
            // A pending sign-in is not an empty course: the route never
            // answered, so the result says so instead of reporting zero
            // announcements as if that were a real measurement.
            if (isAuthUnavailable(error)) {
              log("DEBUG", `get_announcements: sign-in pending for course ${courseId}`, error);
              const notice =
                "Sign-in to Brightspace is still in progress, so announcements for this course " +
                `could not be fetched yet. ${authPendingNotice(error)} Call get_announcements again ` +
                "once sign-in finishes.";
              // With modifiedSince the response is already an object (that is
              // the shape those callers already get), so authPending/notice
              // join the rest of the JSON there. Without it the response is
              // always a bare array — a shape change would break every
              // existing caller — so the empty array stays content[0] and the
              // notice becomes a second content block instead.
              if (modifiedSince) {
                return toolResponse({
                  announcements: [],
                  modifiedSince,
                  returned: 0,
                  filteredOut: 0,
                  authPending: true,
                  notice,
                });
              }
              return toolResponseWithNotice([], notice);
            }
            throw error;
          }
        }

        // All courses case
        // First, fetch enrolled courses. isActive=true is the configured
        // policy, not a constant: with activeOnly off the user asked to see
        // past courses, and the server would otherwise drop them before
        // applyCourseFilter ever saw them.
        const enrollmentPath = apiClient.lp(
          `/enrollments/myenrollments/?orgUnitTypeId=3${
            config.courseFilter.activeOnly ? "&isActive=true" : ""
          }`
        );
        // myenrollments is bookmark-paged; reading only the first page hides
        // every course past it, and with it every announcement they carry.
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
            startDate: item.Access.StartDate,
            endDate: item.Access.EndDate,
            ...item,
          })),
          config.courseFilter
        );

        // Fetch announcements for each course (handle 403s gracefully)
        const announcementPromises = filteredEnrollments.map(
          async (item) => {
            try {
              const newsItems = await fetchCourseNews(apiClient, item.OrgUnit.Id);

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
              // A pending sign-in only means this course's route never
              // answered — it says nothing about the other courses, whose
              // requests may already have gone out independently. Mark this
              // one rather than failing the whole call and losing every
              // course that *did* answer.
              if (isAuthUnavailable(error)) {
                log(
                  "DEBUG",
                  `get_announcements: sign-in pending for course ${item.OrgUnit.Id} (${item.OrgUnit.Name})`
                );
                return { authPending: true as const, courseId: item.OrgUnit.Id, authError: error };
              }
              throw error; // Re-throw other errors
            }
          }
        );

        const results = await Promise.allSettled(announcementPromises);
        const settled = results
          .filter(
            (r): r is PromiseFulfilledResult<any> => r.status === "fulfilled"
          )
          .map((r) => r.value);

        const pending = settled.filter(
          (v): v is { authPending: true; courseId: number; authError: unknown } =>
            !Array.isArray(v) && v?.authPending === true
        );
        const allAnnouncements = settled.filter((v): v is any[] => Array.isArray(v)).flat();

        const allMatched = cutoff
          ? allAnnouncements.filter((a) => matchesModifiedSince(a.lastModified, cutoff))
          : allAnnouncements;

        // Sort by the scheduled date and slice to count
        const announcements = allMatched
          .sort(newestFirst)
          .slice(0, count);

        log(
          "INFO",
          `get_announcements: Retrieved ${announcements.length} announcements (out of ${allAnnouncements.length} total ` +
          `across ${enrollmentItems.length} courses${pending.length > 0 ? `, ${pending.length} pending sign-in` : ""})`
        );

        // With modifiedSince the response is already an object (the shape
        // those callers already get), so authPending/unavailableCourseIds/
        // notice join the rest of the JSON there. Without it the response is
        // always a bare array — a shape change would break every existing
        // caller — so a pending course adds a second content block carrying
        // the notice instead of changing content[0].
        if (!modifiedSince) {
          if (pending.length === 0) return toolResponse(announcements);
          return toolResponseWithNotice(
            announcements,
            "Sign-in to Brightspace is still in progress, so announcements for " +
              `${pending.length} course(s) (${pending.map((c) => c.courseId).join(", ")}) could not be ` +
              `fetched yet. ${authPendingNotice(pending[0].authError)} Call get_announcements again once ` +
              "sign-in finishes."
          );
        }

        const response: Record<string, unknown> = {
          announcements,
          modifiedSince,
          returned: announcements.length,
          filteredOut: allAnnouncements.length - allMatched.length,
        };
        if (pending.length > 0) {
          response.authPending = true;
          response.unavailableCourseIds = pending.map((c) => c.courseId);
          response.notice =
            "Sign-in to Brightspace is still in progress, so announcements for " +
            `${pending.length} course(s) (${pending.map((c) => c.courseId).join(", ")}) could not be ` +
            `fetched yet. ${authPendingNotice(pending[0].authError)} Call get_announcements again once ` +
            "sign-in finishes.";
        }
        return toolResponse(response);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
