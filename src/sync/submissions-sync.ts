/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * The assignments phase of a full-course sync: for each visible assignment
 * folder, the student's own submitted files, the instructor's attachments, the
 * feedback attachments, and a feedback.md. Whatever Brightspace did not answer
 * is recorded as unknown, never as "none".
 */

import { ApiError, NetworkError } from "../api/errors.js";
import { fetchCurrentUserId } from "../tools/group-membership.js";
import { toOutputAssessment, type RubricDto } from "../tools/get-assignment-rubric.js";
import { feedbackText } from "../utils/feedback.js";
import { log } from "../utils/logger.js";
import {
  submissionFileUrl,
  readMyFeedback,
  readMySubmissions,
  type DropboxFeedback,
  type DropboxSubmission,
} from "../utils/dropbox-submissions.js";
import { renderFeedbackMarkdown, type FeedbackDocInput, type RubricDoc } from "./feedback-markdown.js";
import type { PhaseContext, SaveOutcome } from "./extras-types.js";
import type { AssignmentRecord } from "./manifest.js";
import { NameSet, foldKey, sanitizeComponent } from "./names.js";

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
  /** Folders the run stopped before finishing (a cap, a deadline, a cancel or a lost sign-in). */
  foldersNotReached: number;
  submissionFilesDownloaded: number;
  assignmentFilesDownloaded: number;
  feedbackFilesDownloaded: number;
  /** feedback.md written new, refreshed because the render changed, left because nothing changed, and left because the student edited it. */
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

const NAME_CHARS = 150;
const MY_FILES = "my files";
const GROUP_FILES = "submission files";
const ASSIGNMENT_FILES = "assignment files";
const FEEDBACK_FILES = "feedback files";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const positiveId = (value: unknown): number | null => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/** One short reason, from a fixed vocabulary: nothing from a response body is echoed. */
export function describeStatus(status: number | null | undefined): string {
  if (status === 403) return "Brightspace refused the request: 403";
  if (typeof status === "number") return `Brightspace answered ${status}`;
  return "Brightspace could not be reached or answered unexpectedly";
}

export function describeRead(error: unknown): string {
  if (error instanceof ApiError) return describeStatus(error.status);
  if (error instanceof NetworkError) return "Could not connect to Brightspace";
  const status = (error as { status?: unknown } | null)?.status;
  return describeStatus(typeof status === "number" ? status : null);
}

/** What is already recorded for a folder, so new names never take a recorded file's name. */
function reserveRecorded(names: NameSet, record: AssignmentRecord | undefined, folder: string): void {
  if (!record) return;
  const prefix = `${record.dir}/${folder}/`;
  for (const entry of Object.values(record.files)) {
    if (entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes("/")) names.add(entry.path.slice(prefix.length));
  }
}

interface Wanted {
  key: string;
  fileId: number;
  fileName: string;
  url: string;
}

const readFileList = (value: unknown): { files: Array<{ fileId: number; fileName: string }> } | { unreadable: true } => {
  if (value === undefined || value === null) return { files: [] };
  if (!Array.isArray(value)) return { unreadable: true };
  const files: Array<{ fileId: number; fileName: string }> = [];
  for (const raw of value) {
    if (!isRecord(raw)) return { unreadable: true };
    const fileId = positiveId(raw.FileId);
    if (fileId === null) return { unreadable: true };
    files.push({ fileId, fileName: typeof raw.FileName === "string" ? raw.FileName : `File ${fileId}` });
  }
  return { files };
};

export async function syncAssignments(ctx: PhaseContext, options: AssignmentsOptions): Promise<AssignmentsOutcome> {
  const out = emptyAssignmentsOutcome();
  const { apiClient, courseId, manifest } = ctx;

  let raw: unknown;
  try {
    raw = await apiClient.get<unknown>(apiClient.le(courseId, "/dropbox/folders/"), { signal: ctx.signal });
  } catch (error) {
    if (ctx.handleStop(error)) return out;
    // A 404 is how Brightspace says the course has no Assignments tool: known, and not unreadable.
    if ((error as { status?: unknown } | null)?.status !== 404) out.listUnreadable = describeRead(error);
    return out;
  }
  const entries = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.Objects) ? raw.Objects : null;
  if (entries === null) {
    out.listUnreadable = "Brightspace answered in a shape the sync does not read";
    return out;
  }

  // Folder names under Assignments/. Recorded folders keep their name even when the assignment is renamed.
  const dirNames = new NameSet(NAME_CHARS);
  for (const [, record] of manifest.assignmentRecords(courseId)) {
    const parts = record.dir.split("/");
    if (parts.length === 2 && parts[0] === "Assignments") dirNames.add(parts[1], true);
  }

  for (const rawFolder of entries) {
    if (!isRecord(rawFolder)) continue;
    const folderId = positiveId(rawFolder.Id);
    if (folderId === null) continue;
    if (rawFolder.IsHidden === true) {
      out.hiddenFoldersSkipped++;
      continue;
    }
    if (ctx.stopped()) {
      out.foldersNotReached++;
      continue;
    }
    const name = typeof rawFolder.Name === "string" ? rawFolder.Name : "";
    const isGroup = rawFolder.GroupTypeId !== null && rawFolder.GroupTypeId !== undefined;
    const unknown = (what: UnknownWhat, reason: string) => out.unknown.push({ folderId, name, what, reason });

    try {
      const finished = await oneAssignment();
      if (finished) {
        out.folders++;
        if (isGroup) out.groupFolders++;
      } else out.foldersNotReached++;
    } catch (error) {
      if (ctx.handleStop(error)) {
        out.foldersNotReached++;
        continue;
      }
      log("WARN", `Course sync: assignment ${folderId} could not be saved`, error);
      unknown("submissions", "Unexpected error");
    }

    /** Returns false when the run stopped before the folder was finished. */
    async function oneAssignment(): Promise<boolean> {
      const existingRecord = manifest.findAssignment(courseId, folderId!);
      let dirRel = existingRecord?.dir;
      if (!dirRel) dirRel = `Assignments/${dirNames.add(sanitizeComponent(name, `Assignment ${folderId}`, NAME_CHARS), true)}`;
      const dirSegments = dirRel.split("/");
      const record: AssignmentRecord = ctx.dryRun ? existingRecord ?? { dir: dirRel, files: Object.create(null) } : manifest.assignment(courseId, folderId!);
      if (!ctx.dryRun) {
        record.dir = dirRel;
        ctx.touch();
      }

      const mine = options.submissions ? await readMySubmissions(apiClient, courseId, folderId!, { signal: ctx.signal }) : undefined;
      if (mine && ctx.stopped()) return false;
      if (mine?.known && mine.submissions.length === 0) out.notSubmitted++;
      if (mine && !mine.known) unknown("submissions", describeStatus(mine.status));

      let feedback: Awaited<ReturnType<typeof readMyFeedback>> | undefined;
      let feedbackUnknown: string | undefined;
      if (mine) {
        feedback = await readMyFeedback(apiClient, courseId, { Id: folderId!, GroupTypeId: isGroup ? Number(rawFolder.GroupTypeId) : null }, mine, { signal: ctx.signal });
        if (ctx.stopped()) return false;
        if (feedback.status === "restricted") feedbackUnknown = describeStatus(403);
        else if (feedback.status === "error") feedbackUnknown = "Brightspace did not return the feedback";
        else if (feedback.groupRouteSkipped) {
          feedbackUnknown = "this is a group assignment, and the student feedback route is not read for groups, so group feedback is unknown";
        } else if (feedback.feedback === null && !mine.known) {
          feedbackUnknown = "the submission list could not be read, so the other feedback routes were not tried";
        }
        if (feedbackUnknown) unknown("feedback", feedbackUnknown);
      }

      let notSaved = 0;
      const saveGroup = async (folder: string, wanted: Wanted[], open: (w: Wanted) => string, count: () => void): Promise<string[]> => {
        const names = new NameSet(NAME_CHARS);
        reserveRecorded(names, existingRecord, folder);
        const otherPaths = (key: string) => new Set(Object.entries(record.files).filter(([k]) => k !== key).map(([, e]) => foldKey(e.path)));
        const listed: string[] = [];
        for (const file of wanted) {
          const planned = record.files[file.key] ? "" : names.add(sanitizeComponent(file.fileName, `File ${file.fileId}`, NAME_CHARS));
          const taken = otherPaths(file.key);
          const result: SaveOutcome = await ctx.saveFile({
            segments: [...dirSegments, folder],
            name: planned || sanitizeComponent(file.fileName, `File ${file.fileId}`, NAME_CHARS),
            prior: record.files[file.key],
            ownedByOther: (candidate) => taken.has(foldKey(candidate)),
            open: async (signal) => ({ response: await apiClient.getRaw(open(file), { signal }) }),
            onSaved: (entry) => {
              record.files[file.key] = entry;
              ctx.touch();
            },
          });
          if (result.status === "saved") count();
          if (["saved", "skipped", "duplicate", "planned"].includes(result.status)) {
            listed.push(result.rel.startsWith(`${dirRel}/`) ? result.rel.slice(dirRel!.length + 1) : result.rel);
          } else notSaved++;
        }
        return listed;
      };

      // The student's own files.
      let myFiles: string[] = [];
      if (mine?.known) {
        const wanted: Wanted[] = [];
        for (const submission of mine.submissions as DropboxSubmission[]) {
          const submissionId = positiveId(submission?.Id);
          if (submissionId === null) continue;
          const list = readFileList(submission.Files);
          if ("unreadable" in list) {
            unknown("submissions", "Brightspace listed this submission's files in a shape the sync does not read");
            continue;
          }
          for (const file of list.files) {
            wanted.push({ key: `sub:${submissionId}:${file.fileId}`, ...file, url: submissionFileUrl(apiClient, courseId, folderId!, submissionId, file.fileId) });
          }
        }
        myFiles = await saveGroup(isGroup ? GROUP_FILES : MY_FILES, wanted, (w) => w.url, () => out.submissionFilesDownloaded++);
      }

      // The instructor's attachments.
      if (options.assignmentFiles) {
        const list = readFileList(rawFolder.Attachments);
        if ("unreadable" in list) unknown("attachments", "Brightspace listed the attachments in a shape the sync does not read");
        else {
          const wanted = list.files.map((file): Wanted => ({ key: `asg:${file.fileId}`, ...file, url: apiClient.le(courseId, `/dropbox/folders/${folderId}/attachments/${file.fileId}`) }));
          await saveGroup(ASSIGNMENT_FILES, wanted, (w) => w.url, () => out.assignmentFilesDownloaded++);
        }
      }

      // The feedback's attachments. The route is documented but unverified on a live school, so any trouble is unknown.
      let feedbackFiles: string[] | { known: false; reason: string } = [];
      if (feedback) {
        if (feedbackUnknown) feedbackFiles = { known: false, reason: feedbackUnknown };
        else if (feedback.feedback) {
          const list = readFileList((feedback.feedback as DropboxFeedback).Files);
          if ("unreadable" in list) {
            feedbackFiles = { known: false, reason: "Brightspace listed the feedback files in a shape the sync does not read" };
            unknown("feedbackFiles", feedbackFiles.reason);
          } else if (list.files.length > 0) {
            let myId: number | undefined;
            let why: string | undefined;
            if (isGroup) why = "group feedback attachments are not fetched";
            else {
              try {
                myId = await fetchCurrentUserId(apiClient);
              } catch (error) {
                if (ctx.handleStop(error)) return false;
                why = describeRead(error);
              }
            }
            if (why !== undefined || myId === undefined) {
              feedbackFiles = { known: false, reason: why ?? "Brightspace did not say who is signed in" };
              unknown("feedbackFiles", feedbackFiles.reason);
            } else {
              const wanted = list.files.map((file): Wanted => ({
                key: `fb:${file.fileId}`,
                ...file,
                url: apiClient.le(courseId, `/dropbox/folders/${folderId}/feedback/user/${myId}/attachments/${file.fileId}`),
              }));
              feedbackFiles = await saveGroup(FEEDBACK_FILES, wanted, (w) => w.url, () => out.feedbackFilesDownloaded++);
            }
          }
        }
      }

      if (ctx.stopped()) return false;

      // feedback.md, last, so it can list what was saved.
      if (mine && feedback) {
        const latest = [...mine.submissions].sort((a, b) => Date.parse(String(a.SubmissionDate)) - Date.parse(String(b.SubmissionDate)) || 0);
        const doc: FeedbackDocInput = {
          folderId: folderId!,
          name,
          isGroup,
          due: typeof rawFolder.DueDate === "string" ? rawFolder.DueDate : null,
          points: isRecord(rawFolder.Assessment) && typeof rawFolder.Assessment.ScoreDenominator === "number" ? rawFolder.Assessment.ScoreDenominator : null,
          submissions: mine.known
            ? { known: true, items: latest.map((s) => ({ date: String(s.SubmissionDate ?? ""), by: s.SubmittedBy?.DisplayName ?? null })) }
            : { known: false, reason: describeStatus(mine.status) },
          files: myFiles,
          filesNotSaved: notSaved,
          feedback: feedbackUnknown
            ? { known: false, reason: feedbackUnknown }
            : {
                known: true,
                score: typeof feedback.feedback?.Score === "number" ? feedback.feedback.Score : null,
                text: feedbackText(feedback.feedback?.Feedback),
                rubrics: rubricsOf(feedback.feedback, rawFolder),
                released: feedback.feedback !== null && feedback.feedback.IsGraded !== false,
              },
          feedbackFiles,
        };
        const written = await ctx.saveText({
          segments: dirSegments,
          name: "feedback.md",
          content: renderFeedbackMarkdown(doc),
          prior: record.feedback,
          onWritten: (entry) => {
            record.feedback = entry;
            ctx.touch();
          },
        });
        if (written.status === "written") out.feedbackWritten++;
        else if (written.status === "refreshed") out.feedbackRefreshed++;
        else if (written.status === "unchanged") out.feedbackUnchanged++;
        else if (written.status === "edited") out.feedbackEditedNotRefreshed++;
      }
      return true;
    }
  }
  return out;
}

/** The student's rubric outcomes, with the rubric's own criterion and level names. */
function rubricsOf(feedback: DropboxFeedback | null, folder: Record<string, unknown>): RubricDoc[] {
  if (!feedback || !Array.isArray(feedback.RubricAssessments)) return [];
  const rubrics = isRecord(folder.Assessment) && Array.isArray(folder.Assessment.Rubrics) ? (folder.Assessment.Rubrics as RubricDto[]) : [];
  return feedback.RubricAssessments.map((assessment) => {
    const rubric = rubrics.find((r) => r.RubricId === assessment.RubricId);
    const outcome = toOutputAssessment(rubric ?? ({ RubricId: assessment.RubricId, Name: "" } as RubricDto), assessment);
    return {
      name: rubric?.Name || `Rubric ${assessment.RubricId}`,
      overall: { score: outcome.score, levelName: outcome.levelName, feedback: outcome.feedback },
      criteria: outcome.criteria,
    };
  });
}
