/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import fs from "node:fs/promises";
import { createWriteStream, constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  validateDownloadPath,
  validateFileType,
  validateFileTypeOfFile,
  MAX_FILE_SIZE,
} from "./file-validator.js";
import { DownloadError } from "./download-errors.js";
import { log } from "./logger.js";

/**
 * Resolve filename conflicts by appending (1), (2), etc.
 *
 * @param dir - Target directory
 * @param filename - Original filename
 * @returns First available filename (may be original or with suffix)
 */
export async function resolveFilenameConflict(
  dir: string,
  filename: string
): Promise<string> {
  const fullPath = path.join(dir, filename);

  try {
    await fs.access(fullPath);
    // File exists, need to resolve conflict
  } catch {
    // File doesn't exist, use original name
    return filename;
  }

  // Parse filename into name and extension
  const ext = path.extname(filename);
  const basename = path.basename(filename, ext);

  // Try filename(1), filename(2), etc.
  for (let i = 1; i <= 100; i++) {
    const candidate = `${basename}(${i})${ext}`;
    const candidatePath = path.join(dir, candidate);

    try {
      await fs.access(candidatePath);
      // File exists, try next
    } catch {
      // File doesn't exist, use this name
      return candidate;
    }
  }

  throw new Error("Could not resolve filename conflict after 100 attempts");
}

/**
 * Securely download file with validation, conflict resolution, and size limits.
 *
 * @param options - Download configuration
 * @returns Download result with path, size, and detected MIME type
 * @throws Error if validation fails or file system operation fails
 */
export async function secureDownload(options: {
  targetDir: string;
  filename: string;
  data: Buffer;
  allowedTypes?: string[];
}): Promise<{ path: string; size: number; mime: string }> {
  const { targetDir, filename, data, allowedTypes } = options;

  log("DEBUG", `secureDownload: starting download of ${filename} to ${targetDir}`);

  // Validate target directory exists and is a directory
  try {
    const stats = await fs.stat(targetDir);
    if (!stats.isDirectory()) {
      throw new Error(`Target path is not a directory: ${targetDir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Target directory does not exist: ${targetDir}`);
    }
    throw error;
  }

  // Validate file size
  const size = data.byteLength;
  if (size > MAX_FILE_SIZE) {
    throw new Error(
      `File size (${size} bytes) exceeds maximum allowed (${MAX_FILE_SIZE} bytes)`
    );
  }
  log("DEBUG", `secureDownload: file size ${size} bytes (within limit)`);

  // Validate download path (prevent path traversal) and keep the name it
  // sanitized. validateDownloadPath used to be called for its throw alone while
  // the write below still used the raw filename, so a Brightspace-supplied
  // "../../name.pdf" resolved cleanly through validation and was then written
  // two directories above targetDir. Everything past this point — type
  // detection included — uses the name the file actually gets on disk.
  const validatedPath = validateDownloadPath(targetDir, filename);
  const safeFilename = path.basename(validatedPath);
  log("DEBUG", `secureDownload: path validated as ${validatedPath}`);

  // Validate file type via magic bytes
  // The filename decides which legacy Office format a CFB container is.
  const { mime } = await validateFileType(data, allowedTypes, safeFilename);
  log("DEBUG", `secureDownload: file type validated as ${mime}`);

  // Resolve filename conflicts
  const resolvedFilename = await resolveFilenameConflict(targetDir, safeFilename);
  const finalPath = path.join(targetDir, resolvedFilename);
  log("DEBUG", `secureDownload: resolved filename to ${resolvedFilename}`);

  // Write file to disk
  await fs.writeFile(finalPath, data);
  log("INFO", `Downloaded file to ${finalPath} (${size} bytes, ${mime})`);

  return {
    path: finalPath,
    size,
    mime,
  };
}

/**
 * secureDownload for a response body that is streamed to disk rather than
 * held in memory, so a file's size is bounded by `maxBytes` instead of by
 * MAX_FILE_SIZE. The body is written to a hidden temporary file in targetDir,
 * type-checked there, and only then published under its final name; a refused or
 * failed download leaves nothing behind.
 *
 * @throws DownloadError("tooLarge") once the body passes maxBytes
 */
export async function secureStreamDownload(options: {
  targetDir: string;
  filename: string;
  body: ReadableStream<Uint8Array>;
  maxBytes: number;
}): Promise<{ path: string; size: number; mime: string }> {
  const { targetDir, filename, body, maxBytes } = options;

  const safeFilename = path.basename(validateDownloadPath(targetDir, filename));
  const partialPath = path.join(targetDir, `.download-${randomUUID()}.part`);

  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new DownloadError("tooLarge", `File exceeds ${maxBytes} bytes`));
      } else {
        callback(null, chunk);
      }
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      limit,
      createWriteStream(partialPath, { flags: "wx" })
    );
    const { mime } = await validateFileTypeOfFile(partialPath, undefined, safeFilename);
    const finalPath = await publishExclusively(partialPath, targetDir, safeFilename);
    log("INFO", `Downloaded file to ${finalPath} (${size} bytes, ${mime})`);
    return { path: finalPath, size, mime };
  } finally {
    await fs.rm(partialPath, { force: true });
  }
}

/**
 * Give a finished temporary file its final name without ever replacing an
 * existing file. resolveFilenameConflict only reports a name that was free a
 * moment ago, and rename() overwrites, so two concurrent downloads of the same
 * name could both pick it and the later rename silently replaced the earlier
 * file. link() and COPYFILE_EXCL fail with EEXIST instead, and we try the next
 * free name. The caller removes the temporary file.
 */
async function publishExclusively(
  partialPath: string,
  targetDir: string,
  filename: string
): Promise<string> {
  for (let attempt = 0; attempt <= 100; attempt++) {
    const finalPath = path.join(targetDir, await resolveFilenameConflict(targetDir, filename));
    try {
      try {
        await fs.link(partialPath, finalPath);
      } catch (error) {
        // Some filesystems (FAT/exFAT drives, certain network shares) have no
        // hard links; copy instead, still refusing to overwrite.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS") throw error;
        await fs.copyFile(partialPath, finalPath, fsConstants.COPYFILE_EXCL);
      }
      return finalPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not resolve filename conflict after 100 attempts");
}

/**
 * Read a response body into memory, refusing to hold more than `maxBytes`.
 *
 * response.arrayBuffer() buffers whatever the server sends, so a missing or
 * understated Content-Length let an arbitrarily large body be allocated before
 * any size check ran. This counts the bytes actually received and cancels the
 * stream as soon as they pass the cap.
 *
 * @throws DownloadError("tooLarge") once the body passes maxBytes
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new DownloadError("tooLarge", `File exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}
