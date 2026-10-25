/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

/**
 * Deep links into the Brightspace web UI.
 *
 * Every template here was harvested from live Brightspace markup: they are
 * the same URLs the course pages themselves link to, so they open the item
 * directly. The discussion template was first written from the shape of the
 * others and answered 404 on a real tenant; it now uses the link the course's
 * own Discussions List page gives each topic.
 */

/** Drop trailing slashes so the templates below join cleanly. */
function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Link to the submit-files page of a dropbox folder. */
export function assignmentUrl(
  baseUrl: string,
  courseId: number,
  folderId: number,
  groupId: number = 0
): string {
  return `${trimBaseUrl(baseUrl)}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folderId}&grpid=${groupId}&ou=${courseId}`;
}

/** Link to the summary page of a quiz. */
export function quizUrl(
  baseUrl: string,
  courseId: number,
  quizId: number
): string {
  return `${trimBaseUrl(baseUrl)}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${quizId}&ou=${courseId}`;
}

/** Link to a topic in the course content viewer. */
export function contentTopicUrl(
  baseUrl: string,
  courseId: number,
  topicId: number
): string {
  return `${trimBaseUrl(baseUrl)}/d2l/le/content/${courseId}/viewContent/${topicId}/View`;
}

/**
 * Link to a course's own grades page. There is no per-column page a student
 * may open, so every gradebook row in a course shares this one link.
 */
export function gradebookUrl(baseUrl: string, courseId: number): string {
  return `${trimBaseUrl(baseUrl)}/d2l/lms/grades/my_grades/main.d2l?ou=${courseId}`;
}

/** Link to a discussion topic's page, which lists its threads. */
export function discussionUrl(
  baseUrl: string,
  courseId: number,
  topicId: number
): string {
  return `${trimBaseUrl(baseUrl)}/d2l/le/${courseId}/discussions/topics/${topicId}/View`;
}

/**
 * Link to a course's calendar. Calendar events have no per-event student page
 * the API names, so every event in a course shares this one link.
 */
export function calendarUrl(baseUrl: string, courseId: number): string {
  return `${trimBaseUrl(baseUrl)}/d2l/le/calendar/${courseId}`;
}
