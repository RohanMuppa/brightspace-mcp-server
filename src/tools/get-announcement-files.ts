/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetAnnouncementFilesSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { describeAttachment, readAttachment } from "./attachment-reader.js";
import { effectiveDate, isPublishedNewsItem, type NewsItem } from "./get-announcements.js";
import { log } from "../utils/logger.js";

/**
 * The files an instructor attached to an announcement: field-notes prompts,
 * a rubric, an updated schedule. They hang off the news item, not course
 * content, so get_course_content never lists them. Same shape as
 * get_assignment_files: list first, then read one file by id.
 */

/** Every posted announcement in the course, narrowed to one when newsId is given. */
async function listNews(
  apiClient: D2LApiClient,
  courseId: number,
  newsId?: number
): Promise<NewsItem[]> {
  const items = await apiClient.get<NewsItem[]>(apiClient.le(courseId, "/news/"), {
    ttl: DEFAULT_CACHE_TTLS.announcements,
  });
  return items
    .filter(isPublishedNewsItem)
    .filter((item) => (newsId === undefined ? true : item.Id === newsId));
}

export function registerGetAnnouncementFiles(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_announcement_files",
    {
      title: "Get Announcement Files",
      description:
        "Read the files an instructor attached to an announcement: prompt questions, a rubric, an updated schedule, slides. Call it with just courseId to see which announcements have attachments, then with newsId and fileId to read one. Use this when the user asks what a file attached to an announcement says. Returns the text itself. Use download_file (newsId + fileId) instead when the user wants the file saved to disk.",
      inputSchema: GetAnnouncementFilesSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_announcement_files tool called", { args });
        const { courseId, newsId, fileId, extractText, maxChars } =
          GetAnnouncementFilesSchema.parse(args);

        if (fileId !== undefined && newsId === undefined) {
          return toolResponse({
            courseId,
            error: "newsId is required when fileId is given.",
          });
        }

        const items = await listNews(apiClient, courseId, newsId);

        if (newsId !== undefined && items.length === 0) {
          return toolResponse({
            courseId,
            newsId,
            error: `No announcement with id ${newsId} in course ${courseId}.`,
          });
        }

        // Read one file.
        if (fileId !== undefined) {
          const item = items[0];
          const attachments = item.Attachments ?? [];
          const attachment = attachments.find((a) => a.FileId === fileId);
          if (!attachment) {
            return toolResponse({
              courseId,
              newsId,
              fileId,
              error: `No attachment with id ${fileId} on announcement "${item.Title}".`,
              available: attachments.map(describeAttachment),
            });
          }
          const file = await readAttachment(
            apiClient,
            apiClient.le(courseId, `/news/${item.Id}/attachments/${fileId}`),
            attachment,
            extractText,
            maxChars
          );
          return toolResponse({ courseId, newsId, title: item.Title, file });
        }

        // Discovery: which announcements have files, without downloading any.
        const withFiles = items
          .filter((item) => (item.Attachments ?? []).length > 0)
          .map((item) => ({
            newsId: item.Id,
            title: item.Title,
            date: effectiveDate(item),
            attachments: (item.Attachments ?? []).map(describeAttachment),
          }));

        log(
          "INFO",
          `get_announcement_files: ${withFiles.length} announcements with attachments in course ${courseId}`
        );
        return toolResponse({
          courseId,
          announcements: withFiles,
          ...(withFiles.length === 0
            ? { note: "No announcement in this course has an attached file." }
            : {}),
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
