/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetAssignmentFilesSchema } from "./schemas.js";
import { toolResponse, sanitizeError } from "./tool-helpers.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { officeDocumentText } from "../utils/zip-extract.js";
import { assignmentUrl } from "../utils/deep-links.js";
import { log } from "../utils/logger.js";

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

interface DropboxAttachment {
  FileId: number;
  FileName: string;
  Size: number;
}

interface DropboxFolder {
  Id: number;
  Name: string;
  DueDate: string | null;
  IsHidden: boolean;
  Attachments: DropboxAttachment[] | null;
}

/** D2L list endpoints return either a paged { Objects: [...] } or a flat array. */
function unwrapList<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : ((raw as any)?.Objects ?? []);
}

type FileKind = "pdf" | "docx" | "xlsx" | "pptx" | "image" | "text" | "other";

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  pdf: "pdf",
  docx: "docx",
  doc: "other",
  xlsx: "xlsx",
  xls: "other",
  pptx: "pptx",
  ppt: "other",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  txt: "text",
  md: "text",
  csv: "text",
  json: "text",
};

export function fileKind(fileName: string): FileKind {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return KIND_BY_EXTENSION[extension] ?? "other";
}

function describeAttachment(attachment: DropboxAttachment) {
  return {
    fileId: attachment.FileId,
    fileName: attachment.FileName,
    size: attachment.Size,
    kind: fileKind(attachment.FileName),
  };
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

/**
 * Read one attachment. The text is best effort: a scanned PDF or an image
 * yields nothing, and that is reported rather than treated as a failure.
 */
async function readAttachment(
  apiClient: D2LApiClient,
  courseId: number,
  folderId: number,
  attachment: DropboxAttachment,
  extract: boolean,
  maxChars: number
): Promise<Record<string, unknown>> {
  const base = describeAttachment(attachment);
  if (!extract) return { ...base, text: null, note: "Text extraction was not requested." };

  const response = await apiClient.getRaw(
    apiClient.le(courseId, `/dropbox/folders/${folderId}/attachments/${attachment.FileId}`)
  );
  const buffer = Buffer.from(await response.arrayBuffer());

  let text: string | null = null;
  let note: string | undefined;

  switch (base.kind) {
    case "pdf": {
      const extracted = await extractPdfText(buffer);
      text = extracted?.text?.trim() || null;
      if (!text) note = "No text layer in this PDF. It may be a scan.";
      break;
    }
    case "docx":
    case "xlsx":
    case "pptx": {
      text = officeDocumentText(buffer);
      if (!text) note = "No readable text found in this Office document.";
      break;
    }
    case "text": {
      text = buffer.toString("utf-8").trim() || null;
      break;
    }
    default: {
      note = `Cannot extract text from a ${base.kind} file. Use download_file to save it.`;
    }
  }

  const truncated = text !== null && text.length > maxChars;
  return {
    ...base,
    bytes: buffer.length,
    text: truncated ? text!.slice(0, maxChars) : text,
    truncated,
    ...(note ? { note } : {}),
  };
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
            courseId,
            folderId,
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
