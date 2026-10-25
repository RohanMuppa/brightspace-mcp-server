/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { tagAttributes } from "./html-attributes.js";
import { toBrightspacePath } from "./transcript/lti.js";

export const QUICKLINK_PATH = "/d2l/common/dialogs/quickLink/quickLink.d2l";
const ENFORCED_PREFIX = "/content/enforced/";

/**
 * Reduce a coursePath argument to a plain course-file path ("Notes/a.pdf").
 * Accepts that path, the quickLink URL a module description carries, or the
 * `/content/enforced/<course folder>/...` href an assignment's instructions
 * carry, and refuses anything that could name a file outside the course file store, so
 * the argument can only ever steer the request inside this course's files.
 * An absolute quickLink URL must be on `origin`; without one, only a
 * root-relative link is accepted.
 */
export function parseCoursePath(input: string, courseId: number, origin?: string): string | { error: string } {
  let filePath = input.trim();

  // A plain course-file path never starts with "/" or names a scheme, so
  // anything that does is a link, however its file name reads.
  if (filePath.startsWith("/") || /^[a-z][a-z\d+.-]*:\/\//i.test(filePath)) {
    const linked = enforcedFilePath(filePath, courseId, origin) ?? quickLinkFilePath(filePath, courseId, origin);
    if (typeof linked !== "string") return linked;
    filePath = linked;
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

/** The course-file path a `quickLink.d2l?type=coursefile` link names, or why it can't be used. */
function quickLinkFilePath(input: string, courseId: number, origin?: string): string | { error: string } {
  const brightspacePath = toBrightspacePath(input, origin);
  const link = brightspacePath === null ? null : new URL(brightspacePath, "https://placeholder.invalid");
  if (link === null || link.pathname !== QUICKLINK_PATH || link.searchParams.get("type") !== "coursefile") {
    return { error: "coursePath must be a course file path, a /content/enforced/ link, or a quickLink URL on this Brightspace with type=coursefile." };
  }
  const ou = link.searchParams.get("ou");
  if (ou !== null && ou !== String(courseId)) {
    return { error: `This quickLink belongs to course ${ou}, not course ${courseId}.` };
  }
  return link.searchParams.get("fileId") ?? "";
}

/**
 * The course-file path a `/content/enforced/<course folder>/<path>` href
 * names, an error when it names one unsafely, or null when the input is not
 * such an href. Read from the raw text, not a parsed URL, because URL parsing
 * would resolve a `..` (or `%2e%2e`) segment out of the course folder before
 * it could be refused. A folder named `<ou>-...` must belong to this course.
 */
function enforcedFilePath(input: string, courseId: number, origin?: string): string | { error: string } | null {
  let path = input;
  if (!path.startsWith("/")) {
    let link: URL;
    try {
      link = new URL(path);
    } catch {
      return null;
    }
    if (!origin || link.origin !== new URL(origin).origin || link.username || link.password) return null;
    path = path.slice(path.indexOf("/", path.indexOf("//") + 2));
  }
  if (!path.startsWith(ENFORCED_PREFIX)) return null;

  // Brightspace serves a backslash in a course-file path as a folder separator
  // (old imported courses link files as csfiles\home_dir\...), so it is read
  // as one here, before the segments are checked.
  const [folder, ...rest] = path.slice(ENFORCED_PREFIX.length).split(/[?#]/)[0].replace(/\\/g, "/").split("/");
  const ou = /^(\d+)-/.exec(folder)?.[1];
  if (ou !== undefined && ou !== String(courseId)) {
    return { error: `This file belongs to course ${ou}, not course ${courseId}.` };
  }
  const segments: string[] = [];
  for (const segment of rest) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { error: "coursePath is not a valid link: it has malformed percent-encoding." };
    }
    // An encoded "/" would let one segment smuggle in several, ".." among them.
    if (decoded.includes("/")) return { error: "coursePath must not hide a '/' inside a single path segment." };
    segments.push(decoded);
  }
  return segments.join("/");
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
