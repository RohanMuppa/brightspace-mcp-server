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
  readMyFeedback,
  readMySubmissions,
  submissionFileUrl,
  type DropboxFeedback,
  type DropboxSubmission,
} from "../utils/dropbox-submissions.js";
import { renderFeedbackMarkdown, type FeedbackDocInput, type NotSaved, type RubricDoc } from "./feedback-markdown.js";
import type { NotRunReason, PhaseContext, SaveOutcome } from "./extras-types.js";
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
  /** The top-level folder the assignments were saved in. */
  folder: string;
  /** Set when the phase did not run because the run had already stopped: nothing was read, so no count below means anything. */
  notRun?: NotRunReason;
  /** Folders listed and not hidden. `folders + foldersPartlySaved + foldersNotReached + foldersUnusable` equals this. */
  foldersListed: number;
  /** Folders finished: everything Brightspace listed for them was saved or already there, and feedback.md was written or kept. */
  folders: number;
  hiddenFoldersSkipped: number;
  /** Folders whose entry had no usable id, so they could not be read. Each is also in `unknown`. */
  foldersUnusable: number;
  groupFolders: number;
  /** Folders the run stopped before reaching (a cap, a deadline, a cancel or a lost sign-in). */
  foldersNotReached: number;
  /** Folders the run stopped in the middle of: some of their files were saved, and no feedback.md was written. */
  foldersPartlySaved: number;
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

export const emptyAssignmentsOutcome = (folder = "Assignments"): AssignmentsOutcome => ({
  folder,
  foldersListed: 0,
  folders: 0,
  foldersUnusable: 0,
  hiddenFoldersSkipped: 0,
  groupFolders: 0,
  foldersNotReached: 0,
  foldersPartlySaved: 0,
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
const MIN_NAME_CHARS = 16;
/** The longest sub-folder name ("submission files"). */
const SUB_FOLDER_CHARS = 16;
const MY_FILES = "my files";
const GROUP_FILES = "submission files";
const ASSIGNMENT_FILES = "assignment files";
const FEEDBACK_FILES = "feedback files";
export const NO_FILE_LIST = "Brightspace's answer had no file list";
const ODD_FILE_LIST = "Brightspace listed a file in a shape the sync does not read";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const positiveId = (value: unknown): number | null => {
  const id = Number(value);
  return typeof value !== "boolean" && value !== null && value !== "" && Number.isSafeInteger(id) && id > 0 ? id : null;
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

/**
 * How many characters a name may have so the longest path stays within the
 * budget: the folder name takes 40% of what is left, the file name the rest.
 * Without a budget (anywhere but Windows) the usual 150.
 */
export function nameCaps(ctx: Pick<PhaseContext, "budget" | "rootLength">, root: string, subChars: number): { dir: number; file: number } {
  if (!Number.isFinite(ctx.budget)) return { dir: NAME_CHARS, file: NAME_CHARS };
  const left = ctx.budget - (ctx.rootLength + 1 + root.length + 1 + 1 + (subChars > 0 ? subChars + 1 : 0));
  const dir = Math.min(NAME_CHARS, Math.max(MIN_NAME_CHARS, Math.floor(left * 0.4)));
  return { dir, file: Math.min(NAME_CHARS, Math.max(MIN_NAME_CHARS, left - dir)) };
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

type FileList = { files: Array<{ fileId: number; fileName: string }> } | { unreadable: string };

/** An absent list is unknown; only a present, empty list is "none". */
const readFileList = (value: unknown): FileList => {
  if (!Array.isArray(value)) return { unreadable: NO_FILE_LIST };
  const files: Array<{ fileId: number; fileName: string }> = [];
  for (const raw of value) {
    const fileId = isRecord(raw) ? positiveId(raw.FileId) : null;
    if (fileId === null) return { unreadable: ODD_FILE_LIST };
    files.push({ fileId, fileName: typeof (raw as Record<string, unknown>).FileName === "string" ? ((raw as Record<string, unknown>).FileName as string) : `File ${fileId}` });
  }
  return { files };
};

export async function syncAssignments(ctx: PhaseContext, options: AssignmentsOptions): Promise<AssignmentsOutcome> {
  const root = ctx.roots.assignments;
  const out = emptyAssignmentsOutcome(root);
  const { apiClient, courseId, manifest } = ctx;

  const notRun = (): AssignmentsOutcome => {
    out.notRun = ctx.notRunReason() ?? "cancelled";
    return out;
  };
  if (ctx.stopped()) return notRun();

  let raw: unknown;
  try {
    raw = await apiClient.get<unknown>(apiClient.le(courseId, "/dropbox/folders/"), { signal: ctx.signal });
  } catch (error) {
    if (ctx.handleStop(error)) return notRun();
    // A 404 is how Brightspace says the course has no Assignments tool: known, and not unreadable.
    if ((error as { status?: unknown } | null)?.status !== 404) out.listUnreadable = describeRead(error);
    return out;
  }
  const entries = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.Objects) ? raw.Objects : null;
  if (entries === null) {
    out.listUnreadable = "Brightspace answered in a shape the sync does not read";
    return out;
  }

  // Folder names under the root. Recorded folders keep their name even when the assignment is renamed.
  const dirNames = new NameSet(NAME_CHARS);
  for (const [, record] of manifest.assignmentRecords(courseId)) {
    const parts = record.dir.split("/");
    if (parts.length === 2 && parts[0] === root) dirNames.add(parts[1], true);
  }
  const caps = nameCaps(ctx, root, SUB_FOLDER_CHARS);
  /** A stop that ends the work in a folder: not a cap, which only matters when a file was actually left. */
  const hardStop = (): boolean => ["auth", "cancelled", "deadline"].includes(ctx.notRunReason() ?? "");

  for (const rawFolder of entries) {
    if (isRecord(rawFolder) && rawFolder.IsHidden === true) {
      out.hiddenFoldersSkipped++;
      continue;
    }
    out.foldersListed++;
    const folderId = isRecord(rawFolder) ? positiveId(rawFolder.Id) : null;
    if (!isRecord(rawFolder) || folderId === null) {
      out.foldersUnusable++;
      out.unknown.push({
        folderId: 0,
        name: isRecord(rawFolder) && typeof rawFolder.Name === "string" ? rawFolder.Name : "",
        what: "submissions",
        reason: "this assignment had no usable id, so it was not saved",
      });
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
      } else out.foldersPartlySaved++;
    } catch (error) {
      if (ctx.handleStop(error)) {
        out.foldersPartlySaved++;
        continue;
      }
      log("WARN", `Course sync: assignment ${folderId} could not be saved`, error);
      unknown("submissions", "Unexpected error");
      out.foldersPartlySaved++;
    }

    /** Returns false when the run stopped before the folder was finished. */
    async function oneAssignment(): Promise<boolean> {
      const existingRecord = manifest.findAssignment(courseId, folderId!);
      let dirRel = existingRecord?.dir;
      if (!dirRel) dirRel = `${root}/${dirNames.add(sanitizeComponent(name, `Assignment ${folderId}`, caps.dir), true, caps.dir)}`;
      const dirSegments = dirRel.split("/");
      const record: AssignmentRecord = ctx.dryRun ? existingRecord ?? { dir: dirRel, files: Object.create(null) } : manifest.assignment(courseId, folderId!);
      if (!ctx.dryRun) {
        record.dir = dirRel;
        ctx.touch();
      }

      const mine = options.submissions ? await readMySubmissions(apiClient, courseId, folderId!, { signal: ctx.signal }) : undefined;
      if (mine && hardStop()) return false;
      if (mine?.known && mine.submissions.length === 0) out.notSubmitted++;
      if (mine && !mine.known) unknown("submissions", describeStatus(mine.status));

      let feedback: Awaited<ReturnType<typeof readMyFeedback>> | undefined;
      let feedbackUnknown: string | undefined;
      if (mine) {
        feedback = await readMyFeedback(apiClient, courseId, { Id: folderId!, GroupTypeId: isGroup ? Number(rawFolder.GroupTypeId) : null }, mine, { signal: ctx.signal });
        if (hardStop()) return false;
        if (feedback.status === "restricted") feedbackUnknown = describeStatus(403);
        else if (feedback.status === "error") feedbackUnknown = "Brightspace did not return the feedback";
        else if (feedback.groupRouteSkipped) {
          feedbackUnknown = "this is a group assignment, and the student feedback route is not read for groups, so group feedback is unknown";
        } else if (feedback.fallbackUnknown) {
          feedbackUnknown = `the other feedback route could not be read: ${describeStatus(feedback.fallbackUnknown.status)}`;
        } else if (feedback.feedback === null && !mine.known) {
          feedbackUnknown = "the submission list could not be read, so the other feedback routes were not tried";
        }
        if (feedbackUnknown) unknown("feedback", feedbackUnknown);
      }

      let incomplete = false;
      const saveGroup = async (folder: string, wanted: Wanted[], count: () => void): Promise<{ listed: string[]; notSaved: NotSaved }> => {
        const names = new NameSet(NAME_CHARS);
        reserveRecorded(names, existingRecord, folder);
        const otherPaths = (key: string) => new Set(Object.entries(record.files).filter(([k]) => k !== key).map(([, e]) => foldKey(e.path)));
        const listed: string[] = [];
        const notSaved: NotSaved = { failed: 0, empty: 0, notYet: 0 };
        for (const file of wanted) {
          const clean = sanitizeComponent(file.fileName, `File ${file.fileId}`, caps.file);
          const planned = record.files[file.key] ? clean : names.add(clean, false, caps.file);
          const taken = otherPaths(file.key);
          const result: SaveOutcome = await ctx.saveFile({
            segments: [...dirSegments, folder],
            name: planned,
            prior: record.files[file.key],
            ownedByOther: (candidate) => taken.has(foldKey(candidate)),
            open: async (signal) => ({ response: await apiClient.getRaw(file.url, { signal }) }),
            onSaved: (entry) => {
              record.files[file.key] = entry;
              ctx.touch();
            },
          });
          if (result.status === "saved") count();
          if (result.status === "notAttempted") incomplete = true;
          if (["saved", "skipped", "duplicate", "planned"].includes(result.status)) {
            listed.push(result.rel.startsWith(`${dirRel}/`) ? result.rel.slice(dirRel!.length + 1) : result.rel);
          } else if (result.status === "empty") notSaved.empty++;
          else if (result.status === "notAttempted") notSaved.notYet++;
          else notSaved.failed++;
        }
        return { listed, notSaved };
      };

      // The student's own files.
      let myFiles: string[] = [];
      let myFilesUnknown: string | undefined;
      let myNotSaved: NotSaved = { failed: 0, empty: 0, notYet: 0 };
      if (mine?.known) {
        const wanted: Wanted[] = [];
        for (const submission of mine.submissions as DropboxSubmission[]) {
          const submissionId = isRecord(submission) ? positiveId(submission.Id) : null;
          if (submissionId === null) {
            myFilesUnknown ??= "a submission had no usable id";
            unknown("submissions", "a submission had no usable id, so its files were not saved");
            continue;
          }
          const list = readFileList(submission.Files);
          if ("unreadable" in list) {
            myFilesUnknown ??= list.unreadable;
            unknown("submissions", list.unreadable);
            continue;
          }
          for (const file of list.files) {
            wanted.push({ key: `sub:${submissionId}:${file.fileId}`, ...file, url: submissionFileUrl(apiClient, courseId, folderId!, submissionId, file.fileId) });
          }
        }
        const saved = await saveGroup(isGroup ? GROUP_FILES : MY_FILES, wanted, () => out.submissionFilesDownloaded++);
        myFiles = saved.listed;
        myNotSaved = saved.notSaved;
      }

      // The instructor's attachments.
      let assignmentFiles: string[] | { known: false; reason: string } | undefined;
      let assignmentNotSaved: NotSaved = { failed: 0, empty: 0, notYet: 0 };
      if (options.assignmentFiles) {
        const list = readFileList(rawFolder.Attachments);
        if ("unreadable" in list) {
          unknown("attachments", list.unreadable);
          assignmentFiles = { known: false, reason: list.unreadable };
        } else {
          const wanted = list.files.map((file): Wanted => ({ key: `asg:${file.fileId}`, ...file, url: apiClient.le(courseId, `/dropbox/folders/${folderId}/attachments/${file.fileId}`) }));
          const saved = await saveGroup(ASSIGNMENT_FILES, wanted, () => out.assignmentFilesDownloaded++);
          assignmentFiles = saved.listed;
          assignmentNotSaved = saved.notSaved;
        }
      }

      // The feedback's attachments. Only released feedback has any. The route is documented but unverified on a live school, so any trouble is unknown.
      const released = feedback?.feedback != null && feedback.feedback.IsGraded !== false;
      let feedbackFiles: string[] | { known: false; reason: string } = [];
      let feedbackNotSaved: NotSaved = { failed: 0, empty: 0, notYet: 0 };
      if (feedback) {
        if (feedbackUnknown) feedbackFiles = { known: false, reason: feedbackUnknown };
        else if (released) {
          const list = readFileList((feedback.feedback as DropboxFeedback).Files);
          if ("unreadable" in list) {
            feedbackFiles = { known: false, reason: list.unreadable };
            unknown("feedbackFiles", list.unreadable);
          } else if (list.files.length > 0) {
            let myId: number | undefined;
            let why: string | undefined;
            if (isGroup) why = "group feedback attachments are not fetched";
            else {
              try {
                myId = await fetchCurrentUserId(apiClient, ctx.signal);
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
              const saved = await saveGroup(FEEDBACK_FILES, wanted, () => out.feedbackFilesDownloaded++);
              feedbackFiles = saved.listed;
              feedbackNotSaved = saved.notSaved;
            }
          }
        }
      }

      // A folder the run stopped in the middle of is partly saved: no feedback.md, so it never claims to be complete.
      if (hardStop() || incomplete) return false;

      // feedback.md, last, so it can list what was saved.
      if (mine && feedback) {
        const latest = [...mine.submissions].sort((a, b) => Date.parse(String(a?.SubmissionDate)) - Date.parse(String(b?.SubmissionDate)) || 0);
        const doc: FeedbackDocInput = {
          folderId: folderId!,
          name,
          isGroup,
          due: typeof rawFolder.DueDate === "string" ? rawFolder.DueDate : null,
          points: isRecord(rawFolder.Assessment) && typeof rawFolder.Assessment.ScoreDenominator === "number" ? rawFolder.Assessment.ScoreDenominator : null,
          submissions: mine.known
            ? { known: true, items: latest.map((s) => ({ date: String(s?.SubmissionDate ?? ""), by: s?.SubmittedBy?.DisplayName ?? null })) }
            : { known: false, reason: describeStatus(mine.status) },
          files: myFiles,
          ...(myFilesUnknown ? { filesUnknown: myFilesUnknown } : {}),
          filesNotSaved: myNotSaved,
          feedback: feedbackUnknown
            ? { known: false, reason: feedbackUnknown }
            : {
                known: true,
                score: typeof feedback.feedback?.Score === "number" ? feedback.feedback.Score : null,
                text: feedbackText(feedback.feedback?.Feedback),
                rubrics: rubricsOf(feedback.feedback, rawFolder),
                released,
              },
          feedbackFiles,
          feedbackFilesNotSaved: feedbackNotSaved,
          ...(assignmentFiles !== undefined ? { assignmentFiles, assignmentFilesNotSaved: assignmentNotSaved } : {}),
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
