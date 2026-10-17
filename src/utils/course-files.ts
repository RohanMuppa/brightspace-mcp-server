/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

export const QUICKLINK_PATH = "/d2l/common/dialogs/quickLink/quickLink.d2l";

/**
 * Reduce a coursePath argument to a plain course-file path ("Notes/a.pdf").
 * Accepts that path or the quickLink URL a module description carries, and
 * refuses anything that could name a file outside the course file store, so
 * the argument can only ever steer the request inside this course's files.
 */
export function parseCoursePath(input: string, courseId: number): string | { error: string } {
  let filePath = input.trim();

  if (filePath.includes("quickLink.d2l")) {
    let link: URL;
    try {
      link = new URL(filePath, "https://placeholder.invalid");
    } catch {
      return { error: "coursePath is not a valid quickLink URL." };
    }
    if (link.pathname !== QUICKLINK_PATH || link.searchParams.get("type") !== "coursefile") {
      return { error: "coursePath must be a course file path or a quickLink URL with type=coursefile." };
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
export function extractCourseFilePaths(html: string, courseId: number): string[] {
  const found: string[] = [];
  for (const [, href] of html.matchAll(/href\s*=\s*["']([^"']*quickLink\.d2l[^"']*)["']/gi)) {
    const parsed = parseCoursePath(href.replace(/&amp;/g, "&"), courseId);
    if (typeof parsed === "string" && !found.includes(parsed)) found.push(parsed);
  }
  return found;
}
