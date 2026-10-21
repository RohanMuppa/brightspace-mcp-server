/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { tagAttributes } from "./html-attributes.js";
import { toBrightspacePath } from "./transcript/lti.js";

export const QUICKLINK_PATH = "/d2l/common/dialogs/quickLink/quickLink.d2l";

/**
 * Reduce a coursePath argument to a plain course-file path ("Notes/a.pdf").
 * Accepts that path or the quickLink URL a module description carries, and
 * refuses anything that could name a file outside the course file store, so
 * the argument can only ever steer the request inside this course's files.
 * An absolute quickLink URL must be on `origin`; without one, only a
 * root-relative link is accepted.
 */
export function parseCoursePath(input: string, courseId: number, origin?: string): string | { error: string } {
  let filePath = input.trim();

  // A plain course-file path never starts with "/" or names a scheme, so
  // anything that does is a link, however its file name reads.
  if (filePath.startsWith("/") || /^[a-z][a-z\d+.-]*:\/\//i.test(filePath)) {
    const brightspacePath = toBrightspacePath(filePath, origin);
    const link = brightspacePath === null ? null : new URL(brightspacePath, "https://placeholder.invalid");
    if (link === null || link.pathname !== QUICKLINK_PATH || link.searchParams.get("type") !== "coursefile") {
      return { error: "coursePath must be a course file path or a quickLink URL on this Brightspace with type=coursefile." };
    }
    const ou = link.searchParams.get("ou");
    if (ou !== null && ou !== String(courseId)) {
      return { error: `This quickLink belongs to course ${ou}, not course ${courseId}.` };
    }
    filePath = link.searchParams.get("fileId") ?? "";
  }

  const segments = filePath.split("/");
  if (
    filePath === "" ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.includes("://") ||
    segments.some(segment => segment === ".." || segment === "." || segment === "")
  ) {
    return { error: "coursePath must be a relative path inside the course files (e.g. 'Notes/Lecture 1.pdf'), without '..' segments." };
  }
  return filePath;
}

/**
 * The course file paths a module description links through
 * `quickLink.d2l?type=coursefile`, in page order, once each. Read from the raw
 * HTML because the Markdown conversion escapes parentheses in file names.
 * Anything parseCoursePath would refuse, and links to other courses, are left out.
 */
export function extractCourseFilePaths(html: string, courseId: number, origin?: string): string[] {
  const found: string[] = [];
  for (const anchor of tagAttributes(html, "a")) {
    const href = anchor.get("href");
    if (!href?.includes("quickLink.d2l")) continue;
    const parsed = parseCoursePath(href, courseId, origin);
    if (typeof parsed === "string" && !found.includes(parsed)) found.push(parsed);
  }
  return found;
}
