/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import { D2LApiClient } from "../api/index.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { officeDocumentText } from "../utils/zip-extract.js";
import { readBodyCapped } from "../utils/download-helpers.js";
import { DownloadError } from "../utils/download-errors.js";
import { MAX_FILE_SIZE } from "../utils/file-validator.js";

/**
 * Reading an attached file as text, wherever Brightspace hangs it: an
 * assignment's dropbox folder or an announcement. Both describe a file the
 * same way, { FileId, FileName, Size }; only the path that serves the bytes
 * differs, so the caller supplies that and this module does the rest.
 */

export interface D2LFileAttachment {
  FileId: number;
  FileName: string;
  Size: number;
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

export function describeAttachment(attachment: D2LFileAttachment) {
  return {
    fileId: attachment.FileId,
    fileName: attachment.FileName,
    size: attachment.Size,
    kind: fileKind(attachment.FileName),
  };
}

/**
 * Read one attachment from the path that serves its bytes. The text is best
 * effort: a scanned PDF or an image yields nothing, and that is reported
 * rather than treated as a failure.
 */
export async function readAttachment(
  apiClient: D2LApiClient,
  sourcePath: string,
  attachment: D2LFileAttachment,
  extract: boolean,
  maxChars: number
): Promise<Record<string, unknown>> {
  const base = describeAttachment(attachment);
  if (!extract) return { ...base, text: null, note: "Text extraction was not requested." };

  // Extraction holds the whole file in memory, so it is capped: refused from
  // the listed size when that is already over, and cut off mid-read when the
  // listed size (or Content-Length) understated it.
  const tooLarge = {
    ...base,
    text: null,
    truncated: false,
    note: `This file is over the ${MAX_FILE_SIZE / 1024 / 1024}MB text extraction limit. Use download_file with an absolute downloadPath to save it to disk instead.`,
  };
  if (attachment.Size > MAX_FILE_SIZE) return tooLarge;

  const response = await apiClient.getRaw(sourcePath);
  let buffer: Buffer;
  try {
    buffer = await readBodyCapped(response, MAX_FILE_SIZE);
  } catch (error) {
    if (error instanceof DownloadError && error.kind === "tooLarge") return tooLarge;
    throw error;
  }

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
