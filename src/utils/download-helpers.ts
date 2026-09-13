/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { validateDownloadPath, validateFileType, MAX_FILE_SIZE } from "./file-validator.js";
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

  // Validate file type via magic bytes
  // The filename decides which legacy Office format a CFB container is.
  const { mime } = await validateFileType(data, allowedTypes, filename);
  log("DEBUG", `secureDownload: file type validated as ${mime}`);

  // Validate download path (prevent path traversal)
  const validatedPath = validateDownloadPath(targetDir, filename);
  log("DEBUG", `secureDownload: path validated as ${validatedPath}`);

  // Resolve filename conflicts
  const resolvedFilename = await resolveFilenameConflict(targetDir, filename);
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
