import type { D2LApiClient } from "../api/index.js";
import { isAuthUnavailable } from "../tools/tool-helpers.js";
import { fetchCurrentUserId } from "../tools/group-membership.js";
import type { RubricAssessmentDto } from "../tools/get-assignment-rubric.js";
import { log } from "./logger.js";

export interface DropboxFeedback {
  IsGraded?: boolean;
  Score: number | null;
  Feedback: { Text: string; Html: string } | null;
  RubricAssessments?: RubricAssessmentDto[];
  /** Files the instructor attached to the feedback. Read nowhere else; the shape is unverified. */
  Files?: unknown;
}

export interface DropboxSubmission {
  /** Present when the tenant answers mysubmissions with D2L's EntityDropbox shape. */
  Submissions?: DropboxSubmission[];
  /** Released feedback D2L embeds in an EntityDropbox / submission entry. */
  Feedback?: (DropboxFeedback & { IsGraded?: boolean }) | null;
  Id: number;
  SubmittedBy: { Identifier: string; DisplayName: string };
  SubmissionDate: string;
  Comment: { Text: string; Html: string } | null;
  Files: Array<{ FileId: number; FileName: string; Size: number }>;
}

/** Request options for the API client: get_assignments caches, the sync reads fresh and can be cancelled. */
export interface ReadOptions {
  ttl?: number;
  signal?: AbortSignal;
}

/**
 * D2L answers the dropbox submission routes in one of two shapes, depending on
 * the school: a flat list of submissions, or EntityDropbox entries
 * ({ Entity, Status, Feedback, Submissions: [...] }) that carry the
 * submissions, and so their Files, one level down. Either may also arrive
 * wrapped as { Objects: [...] }.
 */
export function flattenDropboxSubmissions<T extends object>(
  raw: T[] | { Objects?: T[] } | null | undefined
): T[] {
  const entries: T[] = Array.isArray(raw) ? raw : raw?.Objects ?? [];
  // An entry that has a Submissions array is an EntityDropbox wrapper, never a submission
  // itself, so it is replaced by its children. A null entry is skipped, not a crash.
  return entries.filter((e) => e != null).flatMap((e) => {
    const nested = (e as { Submissions?: unknown }).Submissions;
    return Array.isArray(nested) ? (nested as T[]) : [e];
  });
}

export interface MySubmissionsRead {
  /** False when Brightspace did not answer the list, so "none" is not known. A 404 is known. */
  known: boolean;
  /** The HTTP status of an answer that was not known, or null for a failure with no status. */
  status?: number | null;
  submissions: DropboxSubmission[];
  /** Released feedback embedded in an EntityDropbox entry. */
  embeddedFeedback: DropboxFeedback | null;
}

/**
 * The student's own submissions to one assignment folder. A 404 is how D2L says
 * nothing was submitted (known, empty); any other failure is not known. A lost
 * sign-in is rethrown.
 */
export async function readMySubmissions(
  apiClient: D2LApiClient,
  courseId: number,
  folderId: number,
  options?: ReadOptions
): Promise<MySubmissionsRead> {
  try {
    const raw = await apiClient.get<{ Objects: DropboxSubmission[] } | DropboxSubmission[]>(
      apiClient.le(courseId, `/dropbox/folders/${folderId}/submissions/mysubmissions/`),
      options
    );
    const entries: DropboxSubmission[] = Array.isArray(raw) ? raw : (raw as any).Objects ?? [];
    // D2L documents EntityDropbox ({ Feedback, Submissions: [...] }) for this
    // route; older tenants answer with the flat submissions. Accept both.
    return {
      known: true,
      submissions: flattenDropboxSubmissions(entries),
      embeddedFeedback: entries.find((e) => e?.Feedback)?.Feedback ?? null,
    };
  } catch (error: any) {
    if (isAuthUnavailable(error)) throw error;
    // 404 is how D2L reports "nothing submitted yet": that one is known.
    if (error?.status === 404) return { known: true, submissions: [], embeddedFeedback: null };
    log("DEBUG", `Could not determine submission state for folder ${folderId}`, error);
    return { known: false, status: typeof error?.status === "number" ? error.status : null, submissions: [], embeddedFeedback: null };
  }
}

export type FeedbackStatus = "retrieved" | "unavailable" | "restricted" | "error";

export interface MyFeedbackRead {
  feedback: DropboxFeedback | null;
  status: FeedbackStatus;
  source: "myFeedback" | "submission" | "user" | null;
  /** Set when no feedback was found and the student route was not tried because the folder is a group folder. */
  groupRouteSkipped?: boolean;
}

/**
 * The student's own released feedback for one assignment folder: myFeedback,
 * then the feedback embedded in mysubmissions, then feedback/user/{me}.
 * Draft (IsGraded: false) feedback is not released. The user route is never
 * tried for a group folder. A lost sign-in is rethrown.
 */
export async function readMyFeedback(
  apiClient: D2LApiClient,
  courseId: number,
  folder: { Id: number; GroupTypeId?: number | null },
  mine: Pick<MySubmissionsRead, "submissions" | "embeddedFeedback">,
  options?: ReadOptions
): Promise<MyFeedbackRead> {
  let feedback: DropboxFeedback | null = null;
  let status: FeedbackStatus = "unavailable";
  try {
    feedback = await apiClient.get<DropboxFeedback>(
      apiClient.le(courseId, `/dropbox/folders/${folder.Id}/feedback/myFeedback/`),
      options
    );
    status = feedback ? "retrieved" : "unavailable";
  } catch (error: any) {
    if (isAuthUnavailable(error)) throw error;
    // Permission failures, missing API records, and transport failures
    // do not establish whether published feedback exists in the UI.
    status = error?.status === 403 ? "restricted" : error?.status === 404 ? "unavailable" : "error";
    if (error?.status !== 404 && error?.status !== 403) {
      log("DEBUG", `Failed to fetch feedback for folder ${folder.Id}`, error);
    }
  }

  // myFeedback is not one of D2L's documented entity types, so when it has
  // nothing, read the student's own released feedback from the documented
  // routes: the Feedback embedded in mysubmissions (already fetched), then
  // feedback/user/{me}.
  let source: MyFeedbackRead["source"] = feedback ? "myFeedback" : null;
  let groupRouteSkipped = false;
  if (!feedback && mine.submissions.length > 0) {
    const individual = folder.GroupTypeId === null || folder.GroupTypeId === undefined;
    if (mine.embeddedFeedback && mine.embeddedFeedback.IsGraded !== false) {
      feedback = mine.embeddedFeedback;
      source = "submission";
    } else if (individual) {
      try {
        const myId = await fetchCurrentUserId(apiClient);
        const own = await apiClient.get<DropboxFeedback>(
          apiClient.le(courseId, `/dropbox/folders/${folder.Id}/feedback/user/${myId}`),
          options
        );
        if (own && own.IsGraded !== false) {
          feedback = own;
          source = "user";
        }
      } catch (error: any) {
        if (isAuthUnavailable(error)) throw error;
        log("DEBUG", `Own-feedback fallback failed for folder ${folder.Id}`, error);
      }
    } else {
      groupRouteSkipped = true;
    }
    if (feedback) status = "retrieved";
  }
  return { feedback, status, source, ...(feedback === null && groupRouteSkipped ? { groupRouteSkipped } : {}) };
}

/**
 * The route of one file of a submission, answered as a file stream.
 * **Why:** D2L documents it without a `/download` suffix, and the suffixed form 404s on a live school (2026-11-19).
 */
export function submissionFileUrl(
  apiClient: D2LApiClient,
  courseId: number,
  folderId: number,
  submissionId: number,
  fileId: number
): string {
  return apiClient.le(courseId, `/dropbox/folders/${folderId}/submissions/${submissionId}/files/${fileId}`);
}
