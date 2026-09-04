/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Tool registration functions - barrel export
export { registerGetMyCourses } from "./get-my-courses.js";
export { registerGetUpcomingDueDates } from "./get-upcoming-due-dates.js";
export { registerGetMyGrades } from "./get-my-grades.js";
export { registerGetAnnouncements } from "./get-announcements.js";
export { registerGetAssignments } from "./get-assignments.js";
export { registerGetAssignmentFiles } from "./get-assignment-files.js";
export { registerGetCourseContent } from "./get-course-content.js";
export { registerDownloadFile } from "./download-file.js";
export { registerGetClasslistEmails } from "./get-classlist-emails.js";
export { registerGetRoster } from "./get-roster.js";
export { registerGetSyllabus } from "./get-syllabus.js";
export { registerGetDiscussions } from "./get-discussions.js";

// Re-export shared helpers and schemas for convenience
export { toolResponse, errorResponse, sanitizeError } from "./tool-helpers.js";
export * from "./schemas.js";
