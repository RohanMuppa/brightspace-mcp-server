/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import { inflateRawSync } from "node:zlib";

/**
 * A dependency-free reader for the one thing we need out of a ZIP: a single
 * named entry. DOCX, XLSX, and PPTX are all ZIP archives, and on a live course
 * the assignment attachments were a DOCX and an XLSX, so reading them is what
 * makes an attachment useful rather than just listed.
 *
 * The central directory is the index, and it is what this walks. Scanning the
 * file for local header magic is the obvious shortcut and it is wrong: those
 * four bytes can appear inside compressed content, and then the reader is
 * parsing a header that does not exist.
 *
 * Nothing here throws. A truncated download, an unsupported compression
 * method, or a ZIP64 archive all return null, because the caller's fallback
 * is simply to report the file without its text.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Find the End of Central Directory record by scanning backwards. */
function findEocd(buffer: Buffer): number | null {
  const earliest = Math.max(0, buffer.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= earliest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return null;
}

function readCentralDirectory(buffer: Buffer): CentralEntry[] | null {
  const eocd = findEocd(buffer);
  if (eocd === null) return null;

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === ZIP64_MARKER) return null; // ZIP64 is out of scope.

  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_SIGNATURE) return null;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);

    const nameStart = offset + 46;
    if (nameStart + nameLength > buffer.length) return null;

    entries.push({
      name: buffer.subarray(nameStart, nameStart + nameLength).toString("utf-8"),
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntryData(buffer: Buffer, entry: CentralEntry): Buffer | null {
  const header = entry.localHeaderOffset;
  if (header + 30 > buffer.length) return null;

  // The local header repeats the name and extra lengths, and its extra field
  // can differ in length from the central one, so read them from here.
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) return null;

  const raw = buffer.subarray(start, end);
  if (entry.method === METHOD_STORED) return Buffer.from(raw);
  if (entry.method !== METHOD_DEFLATE) return null;

  try {
    return inflateRawSync(raw);
  } catch {
    return null;
  }
}

/** One entry from a ZIP archive by exact name, or null. Never throws. */
export function extractZipEntry(buffer: Buffer, entryName: string): Buffer | null {
  try {
    const entries = readCentralDirectory(buffer);
    if (!entries) return null;
    const entry = entries.find((e) => e.name === entryName);
    if (!entry) return null;
    return readEntryData(buffer, entry);
  } catch {
    return null;
  }
}

/** Every entry name in the archive, or null when it does not parse. */
export function listZipEntries(buffer: Buffer): string[] | null {
  try {
    return readCentralDirectory(buffer)?.map((e) => e.name) ?? null;
  } catch {
    return null;
  }
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

/**
 * Strip XML markup down to the words a reader cares about. Paragraph and
 * cell boundaries become spaces so words from adjacent runs do not fuse.
 */
function xmlToText(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => XML_ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Readable text from a DOCX, XLSX, or PPTX buffer, or null when the archive
 * is not an Office document or carries nothing readable.
 */
export function officeDocumentText(buffer: Buffer): string | null {
  const names = listZipEntries(buffer);
  if (!names) return null;

  const read = (name: string): string =>
    xmlToText(extractZipEntry(buffer, name)?.toString("utf-8") ?? "");

  let text = "";

  if (names.includes("word/document.xml")) {
    text = read("word/document.xml");
  } else if (names.includes("xl/sharedStrings.xml")) {
    text = read("xl/sharedStrings.xml");
  } else if (names.some((n) => n.startsWith("ppt/slides/slide"))) {
    const slides = names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => slideNumber(a) - slideNumber(b));
    text = slides.map(read).filter(Boolean).join("\n\n");
  } else {
    return null;
  }

  return text.length > 0 ? text : null;
}

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}
