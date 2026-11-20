/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * The assignments phase of a full-course sync.
 */

import type { PhaseContext } from "./extras-types.js";

export interface AssignmentsOptions {
  /** The student's own files, feedback.md and feedback attachments. */
  submissions: boolean;
  /** The instructor's attachments on each assignment. */
  assignmentFiles: boolean;
}

export type UnknownWhat = "submissions" | "feedback" | "feedbackFiles" | "attachments";

export interface AssignmentsOutcome {
  folders: number;
  hiddenFoldersSkipped: number;
  groupFolders: number;
  /** Folders the run stopped before reaching (a cap, a deadline, a cancel or a lost sign-in). */
  foldersNotReached: number;
  submissionFilesDownloaded: number;
  assignmentFilesDownloaded: number;
  feedbackFilesDownloaded: number;
  /** feedback.md files written new, refreshed because the render changed, and left because nothing changed. */
  feedbackWritten: number;
  feedbackRefreshed: number;
  feedbackUnchanged: number;
  feedbackEditedNotRefreshed: number;
  notSubmitted: number;
  /** What Brightspace did not answer: never to be reported as "none". */
  unknown: Array<{ folderId: number; name: string; what: UnknownWhat; reason: string }>;
  /** Set when the assignment list itself could not be read. */
  listUnreadable?: string;
}

export const emptyAssignmentsOutcome = (): AssignmentsOutcome => ({
  folders: 0,
  hiddenFoldersSkipped: 0,
  groupFolders: 0,
  foldersNotReached: 0,
  submissionFilesDownloaded: 0,
  assignmentFilesDownloaded: 0,
  feedbackFilesDownloaded: 0,
  feedbackWritten: 0,
  feedbackRefreshed: 0,
  feedbackUnchanged: 0,
  feedbackEditedNotRefreshed: 0,
  notSubmitted: 0,
  unknown: [],
});

export async function syncAssignments(_context: PhaseContext, _options: AssignmentsOptions): Promise<AssignmentsOutcome> {
  return emptyAssignmentsOutcome();
}
