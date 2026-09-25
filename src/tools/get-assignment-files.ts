/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetAssignmentFilesSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import {
  describeAttachment,
  readAttachment,
  type D2LFileAttachment,
} from "./attachment-reader.js";
import { assignmentUrl } from "../utils/deep-links.js";
import { log } from "../utils/logger.js";

export { fileKind } from "./attachment-reader.js";

/**
 * The files an instructor attached to an assignment: the spec PDF, the starter
 * workbook, the rubric. Brightspace embeds these in the dropbox folder object
 * itself. The dedicated /attachments/ listing endpoint answers 404 on the
 * tenant this was measured against, so the embedded list is the only index,
 * and the per-file download path is what actually serves the bytes.
 *
 * This tool returns content. download_file saves content to disk. A student
 * asking what they have to do wants the former.
 */

interface DropboxFolder {
  Id: number;
  Name: string;
  DueDate: string | null;
  IsHidden: boolean;
  Attachments: D2LFileAttachment[] | null;
}

/** D2L list endpoints return either a paged { Objects: [...] } or a flat array. */
function unwrapList<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : ((raw as any)?.Objects ?? []);
}

/** Every visible folder in the course that has at least one attachment. */
async function listFolders(
  apiClient: D2LApiClient,
  courseId: number,
  folderId?: number
): Promise<DropboxFolder[]> {
  const raw = await apiClient.get<unknown>(apiClient.le(courseId, "/dropbox/folders/"), {
    ttl: DEFAULT_CACHE_TTLS.assignments,
  });
  return unwrapList<DropboxFolder>(raw)
    .filter((folder) => folder.IsHidden !== true)
    .filter((folder) => (folderId === undefined ? true : folder.Id === folderId));
}

export function registerGetAssignmentFiles(
  server: McpServer,
  apiClient: D2LApiClient,
  baseUrl?: string
): void {
  server.registerTool(
    "get_assignment_files",
    {
      title: "Get Assignment Files",
      description:
        "Read the files an instructor attached to an assignment: the spec or instructions PDF, a starter workbook, a rubric document. Call it with just courseId to see which assignments have attachments, then with folderId and fileId to read one. Use this when the user asks what an assignment requires, what the instructions say, or to summarize a handout. Returns the text itself. Use download_file instead when the user wants the file saved to disk.",
      inputSchema: GetAssignmentFilesSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_assignment_files tool called", { args });
        const { courseId, folderId, fileId, extractText, maxChars } =
          GetAssignmentFilesSchema.parse(args);

        const folders = await listFolders(apiClient, courseId, folderId);

        if (folderId !== undefined && folders.length === 0) {
          return toolResponse({
            courseId,
            folderId,
            error: `No visible assignment with id ${folderId} in course ${courseId}.`,
          });
        }

        // Read one file.
        if (fileId !== undefined) {
          if (folderId === undefined) {
            return toolResponse({
              courseId,
              error: "folderId is required when fileId is given.",
            });
          }
          const folder = folders[0];
          const attachment = (folder.Attachments ?? []).find((a) => a.FileId === fileId);
          if (!attachment) {
            return toolResponse({
              courseId,
              folderId,
              fileId,
              error: `No attachment with id ${fileId} on assignment "${folder.Name}".`,
              available: (folder.Attachments ?? []).map(describeAttachment),
            });
          }
          const file = await readAttachment(
            apiClient,
            apiClient.le(courseId, `/dropbox/folders/${folderId}/attachments/${fileId}`),
            attachment,
            extractText,
            maxChars
          );
          return toolResponse({
            courseId,
            folderId,
            folderName: folder.Name,
            url: baseUrl ? assignmentUrl(baseUrl, courseId, folderId) : null,
            file,
          });
        }

        // Discovery: which assignments have files, without downloading any.
        const withFiles = folders
          .filter((folder) => (folder.Attachments ?? []).length > 0)
          .map((folder) => ({
            folderId: folder.Id,
            folderName: folder.Name,
            dueDate: folder.DueDate,
            url: baseUrl ? assignmentUrl(baseUrl, courseId, folder.Id) : null,
            attachments: (folder.Attachments ?? []).map(describeAttachment),
          }));

        log(
          "INFO",
          `get_assignment_files: ${withFiles.length} assignments with attachments in course ${courseId}`
        );
        return toolResponse({
          courseId,
          assignments: withFiles,
          ...(withFiles.length === 0
            ? { note: "No assignment in this course has an attached file." }
            : {}),
        });
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
