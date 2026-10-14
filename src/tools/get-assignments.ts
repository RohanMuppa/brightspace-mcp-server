/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { fetchAllItems, fetchAllObjects } from "../api/paginate.js";
import { GetAssignmentsSchema } from "./schemas.js";
import { toolResponse, sanitizeError, isAuthUnavailable, authPendingNotice } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { log } from "../utils/logger.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { contentTopicUrl, gradebookUrl, quizUrl } from "../utils/deep-links.js";
import { assignmentLinkResolver } from "./assignment-links.js";
import { dueIn } from "../utils/due-in.js";
import { feedbackText, FEEDBACK_UNAVAILABLE_NOTE } from "../utils/feedback.js";
import { fetchCurrentUserId } from "./group-membership.js";
import { toOutputAssessment, type RubricAssessmentDto, type RubricDto } from "./get-assignment-rubric.js";
import type { AppConfig } from "../types/index.js";

// D2L Dropbox API types
// Adapted from LunaParker/brightspace-mcp-server (MIT).
interface DropboxLinkAttachment {
  LinkId?: number;
  // D2L's documented field is `LinkName`; `Title` is carried too since some
  // tenants/older API versions have been observed using it instead.
  LinkName?: string | null;
  Title?: string | null;
  Href?: string | null;
}

interface DropboxFolder {
  Id: number;
  CategoryId: number | null;
  Name: string;
  CustomInstructions: { Text: string; Html: string } | null;
  DueDate: string | null;
  IsHidden: boolean;
  Assessment: {
    ScoreDenominator: number | null;
    Rubrics: Array<{
      RubricId: number;
      Name: string;
      Criteria: Array<{
        CriterionId: number;
        Name: string;
        Levels: Array<{
          LevelId: number;
          Name: string;
          Points: number;
          Description: { Text: string; Html: string } | null;
        }>;
      }>;
    }>;
  } | null;
  GroupTypeId?: number | null; // absent/null = individual, non-null = group category
  SubmissionType: number | null;
  // Instructor-provided URL links attached to the folder (e.g. a spec doc
  // hosted elsewhere, a starter repo). Absent on tenants/folders with none.
  LinkAttachments?: DropboxLinkAttachment[] | null;
}

interface DropboxSubmission {
  /** Present when the tenant answers mysubmissions with D2L's EntityDropbox shape. */
  Submissions?: DropboxSubmission[];
  /** Released feedback D2L embeds in an EntityDropbox / submission entry. */
  Feedback?: DropboxFeedback & { IsGraded?: boolean } | null;
  Id: number;
  SubmittedBy: { Identifier: string; DisplayName: string };
  SubmissionDate: string;
  Comment: { Text: string; Html: string } | null;
  Files: Array<{ FileId: number; FileName: string; Size: number }>;
}

interface DropboxFeedback {
  IsGraded?: boolean;
  Score: number | null;
  Feedback: { Text: string; Html: string } | null;
  RubricAssessments?: RubricAssessmentDto[];
}

// D2L Quiz API types
/**
 * Quiz rich text as the live tenant sends it: the display string is nested a
 * level deeper, under Text.Html. Older responses put Html at the top level, so
 * both are declared and richTextHtml reads whichever is present.
 */
interface QuizRichText {
  Text?: { Text?: string | null; Html?: string | null } | string | null;
  Html?: string | null;
  IsDisplayed?: boolean;
}

interface QuizTimeLimit {
  IsEnforced: boolean;
  ShowClock: boolean;
  TimeLimitValue: number; // minutes
}

interface QuizReadData {
  QuizId: number;
  Name: string;
  Description: QuizRichText | null;
  Instructions?: QuizRichText | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsActive: boolean;
  AttemptsAllowed: {
    IsUnlimited: boolean;
    NumberOfAttemptsAllowed: number | null;
  } | null;
  // The live field name. TimeLimit is the older flat spelling, kept so a
  // tenant that still sends it keeps working.
  SubmissionTimeLimit?: QuizTimeLimit | null;
  TimeLimit?: QuizTimeLimit | null;
  SubmissionGracePeriod?: number | null;
  Password?: string | null;
  ContentMetadataOnly?: boolean;
  /** The grade column the quiz writes to; ties a gradebook column to its quiz. */
  GradeItemId?: number | null;
}

/** The display HTML of a quiz rich-text field, nested shape or flat. */
function richTextHtml(field: QuizRichText | null | undefined): string | null {
  if (!field) return null;
  const nested =
    typeof field.Text === "object" && field.Text !== null ? field.Text.Html : null;
  return nested ?? field.Html ?? null;
}

interface QuizAttemptData {
  AttemptId: number;
  AttemptNumber: number;
  Score: number | null;
  IsCompleted: boolean;
  CompletedDate: string | null;
}

interface EnrollmentItem {
  OrgUnit: {
    Id: number;
    Name: string;
    Code: string;
  };
  Access: {
    ClasslistRoleName: string;
    IsActive: boolean;
    CanAccess?: boolean;
    StartDate: string | null;
    EndDate: string | null;
    LastAccessed: string | null;
  };
}

// D2L gradebook types
interface GradeObject {
  Id: number;
  Name: string;
  /**
   * What D2L documents on a GradeObject (grade.html, Grade.GradeObject): a
   * string, "Numeric", "PassFail", "SelectBox" or "Text".
   */
  GradeType?: string;
  /**
   * The numeric GRADEOBJ_T. D2L documents it on grade values, not on grade
   * objects, so it is only a fallback for a tenant that sends it anyway.
   */
  GradeObjectTypeId?: number;
  AssociatedTool: { ToolId: number; ToolItemId: number } | null;
  /** Documented on GradeObject (grade.html): the instructor hid the column from students. */
  IsHidden?: boolean;
}

interface ContentQuizTopic {
  TopicId: number;
  Title: string;
  TypeIdentifier?: string;
  Url?: string;
  ActivityId?: string | null;
  /** The tool the topic's activity belongs to; for a quiz topic, the quiz tool. */
  ToolId?: number | null;
  ToolItemId?: number | null;
  /** The grade column the topic's activity writes to. */
  GradeItemId?: number | null;
  ActivityType?: number;
  IsHidden?: boolean;
  IsBroken?: boolean;
  IsExempt?: boolean;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
  Description?: QuizRichText | null;
}

interface ContentModule {
  Modules?: ContentModule[];
  Topics?: ContentQuizTopic[];
}

interface ContentTableOfContents {
  Modules?: ContentModule[];
}

/**
 * The grade types a student is actually scored on. D2L documents exactly four
 * GradeObject shapes, told apart by a string GradeType; anything else a
 * gradebook lists (category, calculated, formula, final grade) is the
 * gradebook's own arithmetic, not work anybody owes. Those are not documented
 * as GradeType values, so a column is excluded when its GradeType is some
 * other string, and a calculated column also carries no AssociatedTool.
 */
const STUDENT_SCORED_TYPES = new Set(["numeric", "passfail", "selectbox", "text"]);

/** The numeric GRADEOBJ_T values for the same four types: 1 numeric, 2 passfail, 3 selectbox, 4 text. */
const STUDENT_SCORED = new Set([1, 2, 3, 4]);

function isStudentScored(column: GradeObject | null | undefined): column is GradeObject {
  if (!column || typeof column !== "object") return false;
  if (typeof column.GradeType === "string" && STUDENT_SCORED_TYPES.has(column.GradeType.toLowerCase())) return true;
  return STUDENT_SCORED.has(column.GradeObjectTypeId as number);
}

/** The columns a student is scored on, from whatever the grades route returned. */
function studentScoredColumns(gradebook: unknown): GradeObject[] {
  if (!Array.isArray(gradebook)) return [];
  return (gradebook as GradeObject[]).filter((c) => isStudentScored(c) && typeof c.Id === "number");
}

/** Which route a quiz was found through, reported on every quiz row. */
type QuizSource = "quizList" | "courseContent" | "gradebook";

/** A quiz and the route that found it. A content topic with no id has QuizId null. */
interface FoundQuiz {
  quiz: Omit<QuizReadData, "QuizId"> & { QuizId: number | null };
  source: QuizSource;
  /** The content topic behind a quiz recovered from course content. */
  topicId?: number;
  /** The content topic marks the user exempt from this quiz (IsExempt). */
  exempt?: boolean;
}

/** The quiz id a content topic points at, or null when it carries none. */
function contentQuizId(topic: ContentQuizTopic): number | null {
  const candidates = [
    topic.ToolItemId,
    Number(topic.ActivityId),
    // quiz_summary.d2l?qi=N and quiz_start_frame_auto.d2l?qi=N: the same qi
    // parameter quizUrl() builds, present when ToolItemId is not.
    Number(/(?:[?&]|&amp;)qi=(\d+)(?:[&#]|$)/i.exec(topic.Url ?? "")?.[1]),
  ];
  for (const id of candidates) {
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
  }
  return null;
}

/** Titles compare by words, not by case or spacing, so a topic can be matched to a listed quiz. */
function normalizedTitle(title: unknown): string {
  return typeof title === "string" ? title.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

/** Every quiz topic in a table of contents, depth first, hidden or broken ones included. */
function quizTopicsOf(raw: unknown): ContentQuizTopic[] {
  if (!raw || typeof raw !== "object") return [];

  const found: ContentQuizTopic[] = [];
  const visit = (modules: ContentModule[] | undefined, depth: number): void => {
    if (!Array.isArray(modules) || depth > 50) return;
    for (const module of modules) {
      for (const topic of module.Topics ?? []) {
        const isQuiz = topic.ActivityType === 4
          || topic.TypeIdentifier?.toLowerCase() === "quiz"
          || /(?:[?&]|&amp;)type=quiz(?:[&#]|$)/i.test(topic.Url ?? "")
          || /\/lms\/quizzing\/user\/quiz_/i.test(topic.Url ?? "");
        if (isQuiz) found.push(topic);
      }
      visit(module.Modules, depth + 1);
    }
  };

  visit((raw as ContentTableOfContents).Modules, 0);
  return found;
}

/**
 * The quiz tool's id as content quiz topics report it (ToolId, documented on
 * every ToC topic). Tells the gradebook probe which columns belong to quizzes.
 */
function contentQuizToolIds(raw: unknown): Set<number> {
  return new Set(
    quizTopicsOf(raw)
      .map((topic) => topic.ToolId)
      .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
  );
}

/**
 * The quiz id behind a topic that names none, when the grade column the topic
 * writes to (GradeItemId, documented on ToC topics) is linked to a tool item.
 * A column of a different tool than the topic's is not the topic's quiz.
 */
function quizIdFromGradeColumn(
  topic: ContentQuizTopic,
  columnsById: Map<number, GradeObject>
): number | null {
  if (typeof topic.GradeItemId !== "number") return null;
  const tool = columnsById.get(topic.GradeItemId)?.AssociatedTool;
  const itemId = tool?.ToolItemId;
  if (typeof itemId !== "number" || !Number.isSafeInteger(itemId) || itemId <= 0) return null;
  if (typeof topic.ToolId === "number" && typeof tool?.ToolId === "number" && topic.ToolId !== tool.ToolId) {
    return null;
  }
  return itemId;
}

/**
 * Quiz topics visible in course content but absent from the quiz listing.
 * Topics are returned once each. Those that name a quiz (directly, or through
 * their grade column) are keyed by id; one that names none is kept only if no
 * listed quiz carries its title, and one linked from several modules is kept
 * once, recognized by its title and link.
 */
function missingContentQuizTopics(
  raw: unknown,
  listedIds: Set<number>,
  listedTitles: Set<string>,
  columnsById: Map<number, GradeObject>
): Array<{ topic: ContentQuizTopic; quizId: number | null }> {
  const found = new Map<string, { topic: ContentQuizTopic; quizId: number | null }>();
  for (const topic of quizTopicsOf(raw)) {
    // A hidden or broken topic is not something the student can open. An
    // exempt one (IsExempt: the user is exempt from the topic, per the
    // content docs) is still listed, and flagged as exempt on its row.
    if (topic.IsHidden || topic.IsBroken) continue;

    const quizId = contentQuizId(topic) ?? quizIdFromGradeColumn(topic, columnsById);
    if (quizId !== null) {
      if (listedIds.has(quizId)) continue;
    } else if (listedTitles.has(normalizedTitle(topic.Title))) {
      continue;
    }
    const url = (topic.Url ?? "").trim();
    const key = quizId !== null
      ? `quiz:${quizId}`
      : url !== "" ? `link:${normalizedTitle(topic.Title)}|${url}` : `topic:${topic.TopicId}`;
    if (!found.has(key)) found.set(key, { topic, quizId });
  }
  return [...found.values()];
}

/**
 * Resolve quizzes that D2L's list route omitted but the student's visible
 * content table of contents still references. The individual quiz route gives
 * us the normal full shape. If that route is also unavailable, the content
 * topic still provides enough information to avoid silently hiding the work.
 */
async function recoverContentQuizzes(
  apiClient: D2LApiClient,
  courseId: number,
  toc: unknown,
  listedIds: Set<number>,
  listedTitles: Set<string>,
  columnsById: Map<number, GradeObject>
): Promise<{ found: FoundQuiz[]; considered: number; read: number }> {
  const topics = missingContentQuizTopics(toc, listedIds, listedTitles, columnsById);
  // Only the first topics are asked for their details; the rest are listed
  // from the table of contents alone, so a huge course costs a bounded number
  // of requests and no quiz is dropped.
  const readable = Math.min(topics.length, MAX_CONTENT_QUIZ_RECOVERIES);
  const found = await Promise.all(topics.map(async ({ topic, quizId }, index): Promise<FoundQuiz> => {
    const exempt = topic.IsExempt === true ? { exempt: true } : {};
    const mayRead = index < MAX_CONTENT_QUIZ_RECOVERIES;
    if (mayRead && quizId !== null) {
      try {
        const quiz = await apiClient.get<QuizReadData>(apiClient.le(courseId, `/quizzes/${quizId}`), {
          ttl: DEFAULT_CACHE_TTLS.assignments,
        });
        return { quiz, source: "courseContent", topicId: topic.TopicId, ...exempt };
      } catch (error) {
        if (isAuthUnavailable(error)) throw error;
        log("DEBUG", `Failed to fetch content-linked quiz ${quizId}: using content metadata`, error);
      }
    }

    let detail = topic;
    if (mayRead) {
      try {
        detail = await apiClient.get<ContentQuizTopic>(
          apiClient.le(courseId, `/content/topics/${topic.TopicId}`),
          { ttl: DEFAULT_CACHE_TTLS.courseContent }
        );
      } catch (error) {
        if (isAuthUnavailable(error)) throw error;
        log("DEBUG", `Failed to fetch content topic ${topic.TopicId}: using table-of-contents metadata`, error);
      }
    }

    return {
      source: "courseContent",
      topicId: topic.TopicId,
      ...exempt,
      quiz: {
        QuizId: quizId,
        Name: detail.Title || topic.Title,
        Description: detail.Description ?? null,
        StartDate: detail.StartDate ?? detail.StartDateTime ?? topic.StartDateTime ?? null,
        EndDate: detail.EndDate ?? detail.EndDateTime ?? topic.EndDateTime ?? null,
        DueDate: detail.DueDate ?? null,
        IsActive: true,
        AttemptsAllowed: null,
        ContentMetadataOnly: true,
      },
    };
  }));
  return { found, considered: topics.length, read: readable };
}

/**
 * Content quizzes per course whose own record (and, failing that, content
 * topic) is read. Each may cost two requests, so a course costs at most 60.
 * Past the cap a quiz is still listed, from the table of contents alone, and
 * the course's quizCoverage says the cap applied.
 */
const MAX_CONTENT_QUIZ_RECOVERIES = 30;

/**
 * Probes per course. A course whose quiz tool is known (a listed or content
 * quiz sits on it) is asked about that tool's other columns, up to 20. With no
 * known quiz tool every non-dropbox column is a candidate, so far fewer are
 * asked: most of them are discussions, surveys or manual items.
 */
const MAX_GRADEBOOK_QUIZ_PROBES = 20;
const MAX_UNTARGETED_GRADEBOOK_QUIZ_PROBES = 5;

/**
 * A quiz read that answered 404 or 403 will answer the same again soon, so it
 * is not repeated for ten minutes. Kept per client (so per signed-in account)
 * and only for those two answers: a 401 is a sign-in matter and a 5xx or a
 * network failure may pass.
 */
const PROBE_REFUSAL_TTL_MS = 10 * 60 * 1000;
const refusedProbes = new WeakMap<object, Map<string, number>>();

function probeRecentlyRefused(apiClient: object, path: string, now: number): boolean {
  const until = refusedProbes.get(apiClient)?.get(path);
  if (until === undefined) return false;
  if (until > now) return true;
  refusedProbes.get(apiClient)!.delete(path);
  return false;
}

function rememberRefusedProbe(apiClient: object, path: string, now: number): void {
  let paths = refusedProbes.get(apiClient);
  if (!paths) {
    paths = new Map();
    refusedProbes.set(apiClient, paths);
  }
  paths.set(path, now + PROBE_REFUSAL_TTL_MS);
}

/**
 * Quizzes behind gradebook columns that nothing else accounted for. A column
 * linked to a tool item (AssociatedTool) the quiz list and content both omit
 * may still be a quiz the student can read by id, so it is asked for once.
 * The answer is accepted only when the quiz names that very column as its
 * GradeItemId: a discussion or survey that happens to share the id answers
 * 404 or names a different column, and stays a bare gradebook row.
 *
 * A column the instructor hid from students is not asked. The folder ids
 * include hidden folders, whose columns are never asked either.
 * Tools already seen on a dropbox folder are not asked; once a quiz tool is
 * known (from a listed or content quiz), only that tool's other columns are.
 * A column named like an id-less content quiz is that quiz, not a new one.
 */
async function recoverGradebookQuizzes(
  apiClient: D2LApiClient,
  courseId: number,
  columns: GradeObject[],
  folderIds: Set<number>,
  quizIds: Set<number>,
  contentQuizTools: Set<number>,
  idlessQuizTitles: Set<string>
): Promise<FoundQuiz[]> {
  const toolIdsOf = (ids: Set<number>): Set<number> => new Set(
    columns
      .filter((c) => ids.has(c.AssociatedTool?.ToolItemId as number))
      .map((c) => c.AssociatedTool!.ToolId)
  );
  const quizTools = new Set([...toolIdsOf(quizIds), ...contentQuizTools]);
  const folderTools = toolIdsOf(folderIds);
  const now = Date.now();

  const candidates = columns
    .filter((c) => {
      const itemId = c.AssociatedTool?.ToolItemId;
      if (typeof itemId !== "number" || !Number.isSafeInteger(itemId) || itemId <= 0) return false;
      if (c.IsHidden === true) return false;
      if (quizIds.has(itemId) || folderIds.has(itemId)) return false;
      if (idlessQuizTitles.has(normalizedTitle(c.Name))) return false;
      if (probeRecentlyRefused(apiClient, apiClient.le(courseId, `/quizzes/${itemId}`), now)) return false;
      if (quizTools.size > 0) return quizTools.has(c.AssociatedTool!.ToolId);
      return !folderTools.has(c.AssociatedTool!.ToolId);
    })
    .slice(0, quizTools.size > 0 ? MAX_GRADEBOOK_QUIZ_PROBES : MAX_UNTARGETED_GRADEBOOK_QUIZ_PROBES);

  const found = await Promise.all(candidates.map(async (column): Promise<FoundQuiz | null> => {
    const itemId = column.AssociatedTool!.ToolItemId;
    const path = apiClient.le(courseId, `/quizzes/${itemId}`);
    try {
      const quiz = await apiClient.get<QuizReadData>(path, { ttl: DEFAULT_CACHE_TTLS.assignments });
      if (quiz?.QuizId === itemId && quiz.GradeItemId === column.Id) {
        return { quiz, source: "gradebook" };
      }
    } catch (error: any) {
      if (isAuthUnavailable(error)) throw error;
      if (error?.status === 404 || error?.status === 403) rememberRefusedProbe(apiClient, path, now);
      log("DEBUG", `Gradebook column ${column.Id} is not a readable quiz (${itemId})`, error);
    }
    return null;
  }));
  return found.filter((item): item is FoundQuiz => item !== null);
}

/**
 * The content table of contents with date-restricted items included. D2L's
 * default view omits modules and topics outside their date window, which is
 * exactly where a closed (or not yet opened) quiz sits; ignoreDateRestrictions
 * is documented to be open to students, and supported from LE 1.67, which the
 * client's latest version covers. D2L documents that unsupported parameters
 * are ignored, so the plain view is only a fallback for a request the tenant
 * rejects outright (400, 403, 404), reported as such so coverage is not
 * overstated. Anything else (429, a 5xx, a dropped connection) says nothing
 * about the parameter, so it is not retried here: the content counts as unread.
 */
async function fetchContentToc(
  apiClient: D2LApiClient,
  courseId: number
): Promise<{ toc: ContentTableOfContents; datesIncluded: boolean }> {
  try {
    const toc = await apiClient.get<ContentTableOfContents>(
      apiClient.le(courseId, "/content/toc?ignoreDateRestrictions=true&ignoreModuleDateRestrictions=true"),
      { ttl: DEFAULT_CACHE_TTLS.courseContent }
    );
    return { toc, datesIncluded: true };
  } catch (error: any) {
    if (isAuthUnavailable(error)) throw error;
    const status = error?.status;
    if (status !== 400 && status !== 403 && status !== 404) throw error;
    log("DEBUG", `Content table of contents with date restrictions ignored was refused (${status}) for course ${courseId}: using the default view`, error);
  }
  const toc = await apiClient.get<ContentTableOfContents>(apiClient.le(courseId, "/content/toc"), {
    ttl: DEFAULT_CACHE_TTLS.courseContent,
  });
  return { toc, datesIncluded: false };
}

const DETAILS_UNAVAILABLE_NOTE =
  "Brightspace showed this quiz in the course content but would not return its details to you; " +
  "it may be closed, not yet open, or limited to certain students. Open the link to check.";

/**
 * Whether a quiz is open, from its own start and end dates alone: before the
 * start it is not yet open, after the end it is closed. With neither date
 * (or none that parses) nothing is said, and a due date never closes a quiz.
 */
function availabilityField(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  now: number = Date.now()
): { availability?: "notYetOpen" | "open" | "closed" } {
  const start = startDate ? new Date(startDate).getTime() : NaN;
  const end = endDate ? new Date(endDate).getTime() : NaN;
  if (!Number.isFinite(start) && !Number.isFinite(end)) return {};
  if (Number.isFinite(start) && now < start) return { availability: "notYetOpen" };
  if (Number.isFinite(end) && now > end) return { availability: "closed" };
  return { availability: "open" };
}

/** Whether a course's quiz list can be read as the whole of its quizzes. */
type QuizCoverage =
  | { quizCoverage: "complete" }
  | { quizCoverage: "incomplete"; quizCoverageNote: string };

/**
 * Coverage of the three routes quizzes are found through. Any one that did
 * not answer may hide quizzes the others cannot see, so the inventory is only
 * complete when all three did.
 */
function quizCoverage(answered: {
  quizList: boolean;
  /** "full" read with date restrictions ignored; "dateRestricted" only the default view. */
  content: "full" | "dateRestricted" | "failed";
  gradebook: boolean;
  /** Content quizzes found, and how many of them had their details read. */
  contentRecovery?: { considered: number; read: number };
}): QuizCoverage {
  const unread = [
    answered.quizList ? null : "the course's quiz list",
    answered.content === "full" ? null
      : answered.content === "dateRestricted"
        ? "the course content with date-restricted items included (quizzes whose module or access window has not opened or has closed are hidden from the default view)"
        : "the course content (checked for quizzes the quiz list omits)",
    answered.gradebook ? null : "the gradebook (checked for graded work the quiz list omits)",
  ].filter((source): source is string => source !== null);
  const recovery = answered.contentRecovery;
  const truncated = recovery !== undefined && recovery.read < recovery.considered;
  if (unread.length === 0 && !truncated) return { quizCoverage: "complete" };
  return {
    quizCoverage: "incomplete",
    quizCoverageNote:
      (unread.length > 0
        ? `Brightspace did not return ${unread.join(", or ")}, so this course may have quizzes not listed here. `
        : "") +
      (truncated
        ? `Brightspace read the details of only the first ${recovery.read} of ${recovery.considered} quizzes found in the course content; ` +
          "the rest are listed from the course content alone, without their details or attempts. "
        : "") +
      "Do not treat the listed quizzes as all of them, and do not report an unlisted quiz as missing or not taken - " +
      "tell the user to check Brightspace directly.",
  };
}

/**
 * Fetch assignments (dropbox + quizzes) for a single course
 *
 * baseUrl is optional: without it the items carry a null url.
 */
export async function fetchCourseAssignments(
  apiClient: D2LApiClient,
  courseId: number,
  baseUrl?: string
): Promise<any[]> {
  return (await fetchCourseInventory(apiClient, courseId, baseUrl)).assignments;
}

/** A course's assignments and quizzes, with whether its quiz list is complete. */
async function fetchCourseInventory(
  apiClient: D2LApiClient,
  courseId: number,
  baseUrl?: string
): Promise<{ assignments: any[] } & QuizCoverage> {
  const assignments: any[] = [];
  const assignmentLink = assignmentLinkResolver(apiClient, baseUrl, courseId);

  // Fetch dropbox folders, quizzes, and the gradebook in parallel. The
  // gradebook is fetched alongside them but read last: a heads-up row is a
  // column that nothing the other two returned matched, so the comparison
  // cannot be made until they have answered.
  const [dropboxResult, quizResult, gradebookResult, contentResult] = await Promise.allSettled([
    apiClient.get<{ Objects: DropboxFolder[] } | DropboxFolder[]>(
      apiClient.le(courseId, "/dropbox/folders/"),
      { ttl: DEFAULT_CACHE_TTLS.assignments }
    ),
    // Quizzes are paged; a course with many of them spills past page one.
    fetchAllObjects<QuizReadData>(apiClient, apiClient.le(courseId, "/quizzes/"), {
      ttl: DEFAULT_CACHE_TTLS.assignments,
    }),
    apiClient.get<GradeObject[]>(apiClient.le(courseId, "/grades/"), {
      ttl: DEFAULT_CACHE_TTLS.assignments,
    }),
    fetchContentToc(apiClient, courseId),
  ]);

  // Each route may fail on its own without costing the others, but a failed
  // sign-in means none of them answered: report that, not an empty course.
  for (const result of [dropboxResult, quizResult, gradebookResult, contentResult]) {
    if (result.status === "rejected" && isAuthUnavailable(result.reason)) throw result.reason;
  }

  // Ids of folders and quizzes the instructor hid or inactivated and that are
  // therefore left out on purpose; their grade columns are not "uncovered".
  const skippedIds = new Set<number>();

  // Process Dropbox folders
  if (dropboxResult.status === "fulfilled") {
    // D2L dropbox endpoint may return paged { Objects: [...] } or flat array
    const dropboxRaw = dropboxResult.value;
    const folders: DropboxFolder[] = Array.isArray(dropboxRaw) ? dropboxRaw : (dropboxRaw as any).Objects ?? [];

    for (const folder of folders) {
      // Skip hidden folders. Their ids are remembered: the instructor hid the
      // work, so its grade column must not resurface as a gradebook row.
      if (folder.IsHidden) {
        skippedIds.add(folder.Id);
        continue;
      }

      // Fetch submissions for this folder. Some tenants deny students access
      // to mysubmissions outright (403), in which case an empty list would be
      // indistinguishable from genuinely unsubmitted work — track whether the
      // answer is actually known so the caller never reports denied-but-real
      // work as missing.
      // Adapted from JoshuaMontclair/brightspace-mcp-server (MIT).
      let submissions: DropboxSubmission[] = [];
      let submissionsKnown = true;
      let embeddedFeedback: DropboxFeedback | null = null;
      try {
        const submissionsRaw = await apiClient.get<{ Objects: DropboxSubmission[] } | DropboxSubmission[]>(
          apiClient.le(courseId, `/dropbox/folders/${folder.Id}/submissions/mysubmissions/`),
          { ttl: DEFAULT_CACHE_TTLS.assignments }
        );
        const entries: DropboxSubmission[] = Array.isArray(submissionsRaw) ? submissionsRaw : (submissionsRaw as any).Objects ?? [];
        // D2L documents EntityDropbox ({ Feedback, Submissions: [...] }) for this
        // route; older tenants answer with the flat submissions. Accept both.
        embeddedFeedback = entries.find((e) => e.Feedback)?.Feedback ?? null;
        submissions = entries.flatMap((e) => (Array.isArray(e.Submissions) ? e.Submissions : [e]));
      } catch (error: any) {
        if (isAuthUnavailable(error)) throw error;
        // 404 is how D2L reports "nothing submitted yet" - that one is known.
        if (error?.status !== 404) {
          submissionsKnown = false;
          log("DEBUG", `Could not determine submission state for folder ${folder.Id}`, error);
        }
      }

      // Fetch feedback independently of submissions
      let feedback: DropboxFeedback | null = null;
      let feedbackStatus: "retrieved" | "unavailable" | "restricted" | "error" = "unavailable";
      try {
        feedback = await apiClient.get<DropboxFeedback>(
          apiClient.le(courseId, `/dropbox/folders/${folder.Id}/feedback/myFeedback/`),
          { ttl: DEFAULT_CACHE_TTLS.assignments }
        );
        feedbackStatus = feedback ? "retrieved" : "unavailable";
      } catch (error: any) {
        if (isAuthUnavailable(error)) throw error;
        // Permission failures, missing API records, and transport failures
        // do not establish whether published feedback exists in the UI.
        feedbackStatus = error?.status === 403 ? "restricted"
          : error?.status === 404 ? "unavailable" : "error";
        if (error?.status !== 404 && error?.status !== 403) {
          log("DEBUG", `Failed to fetch feedback for folder ${folder.Id}`, error);
        }
      }

      // myFeedback is not one of D2L's documented entity types, so when it has
      // nothing, read the student's own released feedback from the documented
      // routes: the Feedback embedded in mysubmissions (already fetched), then
      // feedback/user/{me}. Draft (IsGraded: false) feedback is not released.
      let feedbackSource: "myFeedback" | "submission" | "user" | null = feedback ? "myFeedback" : null;
      if (!feedback && submissions.length > 0) {
        if (embeddedFeedback && embeddedFeedback.IsGraded !== false) {
          feedback = embeddedFeedback;
          feedbackSource = "submission";
        } else if (folder.GroupTypeId === null || folder.GroupTypeId === undefined) {
          try {
            const myId = await fetchCurrentUserId(apiClient);
            const own = await apiClient.get<DropboxFeedback>(
              apiClient.le(courseId, `/dropbox/folders/${folder.Id}/feedback/user/${myId}`),
              { ttl: DEFAULT_CACHE_TTLS.assignments }
            );
            if (own && own.IsGraded !== false) {
              feedback = own;
              feedbackSource = "user";
            }
          } catch (error: any) {
            if (isAuthUnavailable(error)) throw error;
            log("DEBUG", `Own-feedback fallback failed for folder ${folder.Id}`, error);
          }
        }
        if (feedback) feedbackStatus = "retrieved";
      }

      // Instructor-provided URL links attached to the folder. Omitted
      // entirely (rather than an empty array) when the folder has none, to
      // keep the common case's shape exactly as it was.
      // Adapted from LunaParker/brightspace-mcp-server (MIT).
      // D2L's field for the link's display text is `LinkName`; `Title` is
      // kept as a fallback for tenants observed sending that spelling
      // instead. Adapted from JhostinAleck/brightspace-mcp (MIT).
      const linkAttachments = (folder.LinkAttachments ?? [])
        .filter((l): l is DropboxLinkAttachment & { Href: string } => Boolean(l.Href))
        .map((l) => ({ name: l.LinkName ?? l.Title ?? l.Href ?? null, url: l.Href }));

      // Build assignment object
      const overallFeedback = feedbackText(feedback?.Feedback);
      const rubricAssessments = (feedback?.RubricAssessments ?? []).map((assessment) => {
        const rubric = folder.Assessment?.Rubrics?.find((r) => r.RubricId === assessment.RubricId);
        return {
          rubricId: assessment.RubricId,
          ...toOutputAssessment((rubric ?? { RubricId: assessment.RubricId, Name: "" }) as RubricDto, assessment),
        };
      });
      const commentsRetrieved = Boolean(overallFeedback || rubricAssessments.some((rubric) =>
        rubric.feedback || rubric.criteria.some((criterion) => criterion.feedback)));
      const assignment = {
        type: "assignment",
        id: folder.Id,
        name: folder.Name,
        ...await assignmentLink(folder),
        instructions: folder.CustomInstructions?.Html
          ? convertHtmlToMarkdown(folder.CustomInstructions.Html).markdown
          : "",
        dueDate: folder.DueDate,
        dueIn: dueIn(folder.DueDate),
        points: folder.Assessment?.ScoreDenominator ?? null,
        isGroup: folder.GroupTypeId !== null && folder.GroupTypeId !== undefined,
        ...(linkAttachments.length > 0 ? { linkAttachments } : {}),
        rubric: folder.Assessment?.Rubrics?.map((r) => ({
          name: r.Name,
          criteria: r.Criteria?.map((c) => ({
            name: c.Name,
            levels: c.Levels?.map((l) => ({
              name: l.Name,
              points: l.Points,
              description: l.Description?.Text ?? null,
            })) ?? [],
          })) ?? [],
        })) ?? null,
        // New, additive fields: existing "submission" stays null either way
        // when nothing is known, but submissionStatus tells apart "nothing
        // was submitted" (404, a known answer) from "the answer is denied"
        // (any other error), so a caller never states real work as missing.
        submissionStatus: !submissionsKnown
          ? "unknown"
          : submissions.length > 0
            ? "submitted"
            : "not_submitted",
        ...(submissionsKnown ? {} : {
          submissionStatusNote:
            "Brightspace did not return this assignment's submission list, so whether it was submitted " +
            "is unknown. Do not report it as missing or unsubmitted - tell the user to check Brightspace directly.",
        }),
        submission: submissions.length > 0
          ? {
              submittedDate: submissions[0].SubmissionDate,
              files: submissions[0].Files?.map((f) => ({
                name: f.FileName,
                size: f.Size,
                fileId: f.FileId,
              })) ?? [],
              comment: submissions[0].Comment?.Text ?? null,
            }
          : null,
        feedback: feedback
          ? {
              score: feedback.Score,
              feedback: overallFeedback,
              rubricAssessments,
            }
          : null,
        feedbackStatus,
        ...(feedbackSource ? { feedbackSource } : {}),
        feedbackCommentsStatus: commentsRetrieved ? "retrieved" : "unavailable",
        feedbackUrl: baseUrl ? gradebookUrl(baseUrl, courseId) : null,
        ...(commentsRetrieved ? {} : { feedbackStatusNote: FEEDBACK_UNAVAILABLE_NOTE }),
      };

      assignments.push(assignment);
    }
  } else {
    // Log dropbox fetch failure but don't throw
    log("DEBUG", `Failed to fetch dropbox folders for course ${courseId}`, dropboxResult.reason);
  }

  // Process quizzes. Content discovery remains useful when the list route is
  // forbidden or unavailable, so a failed list starts from an empty set.
  const quizzes: FoundQuiz[] = [];
  if (quizResult.status === "fulfilled") {
    quizzes.push(...quizResult.value.map((quiz): FoundQuiz => ({ quiz, source: "quizList" })));
  } else {
    log("DEBUG", `Failed to fetch quizzes for course ${courseId}`, quizResult.reason);
  }

  const knownQuizIds = () => new Set(
    quizzes.map((found) => found.quiz.QuizId).filter((id): id is number => typeof id === "number")
  );
  const knownQuizTitles = () => new Set(quizzes.map((found) => normalizedTitle(found.quiz.Name)));

  const gradebookColumns = gradebookResult.status === "fulfilled"
    ? studentScoredColumns(gradebookResult.value)
    : [];

  let contentRecovery: { considered: number; read: number } | undefined;
  if (contentResult.status === "fulfilled") {
    const recovered = await recoverContentQuizzes(
      apiClient,
      courseId,
      contentResult.value.toc,
      knownQuizIds(),
      knownQuizTitles(),
      new Map(gradebookColumns.map((column) => [column.Id, column]))
    );
    quizzes.push(...recovered.found);
    contentRecovery = { considered: recovered.considered, read: recovered.read };
  } else {
    log("DEBUG", `Failed to fetch course content for quiz discovery in course ${courseId}`, contentResult.reason);
  }

  if (gradebookResult.status === "fulfilled") {
    const folderIds = new Set([
      ...assignments.map((item) => item.id).filter((id): id is number => typeof id === "number"),
      ...skippedIds,
    ]);
    quizzes.push(...await recoverGradebookQuizzes(
      apiClient,
      courseId,
      gradebookColumns,
      folderIds,
      knownQuizIds(),
      contentResult.status === "fulfilled" ? contentQuizToolIds(contentResult.value.toc) : new Set<number>(),
      new Set(
        quizzes.filter((found) => found.quiz.QuizId === null).map((found) => normalizedTitle(found.quiz.Name))
      )
    ));
  }

    // Students on this tenant get 403 from /quizzes/{id}/attempts/. Once the
    // first quiz of a course proves that, the remaining quizzes are not asked:
    // the answer would be the same 403, at one wasted request each.
    let attemptsForbidden = false;

    for (const { quiz, source, topicId, exempt } of quizzes) {
      // Skip quizzes the instructor marked inactive. A row that does not say
      // is not inactive: only an explicit false hides a quiz.
      if (quiz.IsActive === false) {
        if (typeof quiz.QuizId === "number") skippedIds.add(quiz.QuizId);
        continue;
      }

      // Fetch quiz attempts. null means "not measured", which is different
      // from an empty list, and the output says which one it was.
      let attempts: QuizAttemptData[] | null = null;
      if (!attemptsForbidden && !quiz.ContentMetadataOnly && quiz.QuizId !== null) {
        try {
          const attemptsRaw = await apiClient.get<{ Objects: QuizAttemptData[] } | QuizAttemptData[]>(
            apiClient.le(courseId, `/quizzes/${quiz.QuizId}/attempts/`),
            { ttl: DEFAULT_CACHE_TTLS.assignments }
          );
          // D2L attempts endpoint may return paged { Objects: [...] } or flat array
          attempts = Array.isArray(attemptsRaw) ? attemptsRaw : (attemptsRaw as any).Objects ?? [];
        } catch (error: any) {
          if (isAuthUnavailable(error)) throw error;
          if (error?.status === 404) {
            // For a quiz the course's quiz list returned, 404 means no
            // attempts yet: a measurement of zero. A quiz that list did not
            // return is one the quiz API is already hiding from this student,
            // so the same 404 may be that, and says nothing about attempts.
            if (source === "quizList") attempts = [];
            else log("DEBUG", `Attempts for quiz ${quiz.QuizId} answered 404 and it is not a listed quiz: leaving them unknown`);
          } else if (error?.status === 403) {
            attemptsForbidden = true;
            log("DEBUG", `Attempts are forbidden for course ${courseId}: not asking again`);
          } else {
            log("DEBUG", `Failed to fetch attempts for quiz ${quiz.QuizId}`, error);
          }
        }
      }

      // Calculate remaining attempts
      const completedAttempts = attempts?.filter((a) => a.IsCompleted) ?? null;
      let attemptsRemaining: number | string | null = null;
      let attemptWarning: string | null = null;

      if (completedAttempts) {
        attemptsRemaining = "Unlimited";

        if (quiz.AttemptsAllowed && !quiz.AttemptsAllowed.IsUnlimited) {
          const allowed = quiz.AttemptsAllowed.NumberOfAttemptsAllowed ?? 0;
          attemptsRemaining = allowed - completedAttempts.length;

          // Generate warning for low attempts
          if (attemptsRemaining <= 0) {
            attemptWarning = "WARNING: No attempts remaining";
          } else if (attemptsRemaining === 1) {
            attemptWarning = "WARNING: Only 1 attempt remaining";
          }
        }
      }

      const timeLimit = quiz.SubmissionTimeLimit ?? quiz.TimeLimit;
      const descriptionHtml = richTextHtml(quiz.Description);

      // Build quiz object
      const quizAssignment = {
        type: "quiz",
        id: quiz.QuizId,
        ...(quiz.QuizId === null && topicId !== undefined ? { topicId } : {}),
        name: quiz.Name,
        // A content quiz with no quiz id links to its content topic instead.
        url: !baseUrl
          ? null
          : quiz.QuizId !== null
            ? quizUrl(baseUrl, courseId, quiz.QuizId)
            : topicId !== undefined ? contentTopicUrl(baseUrl, courseId, topicId) : null,
        // Which route found this quiz: the course's quiz list, a quiz topic
        // in the course content, or a gradebook column linked to it.
        source,
        instructions: descriptionHtml
          ? convertHtmlToMarkdown(descriptionHtml).markdown
          : "",
        dueDate: quiz.DueDate,
        dueIn: dueIn(quiz.DueDate),
        startDate: quiz.StartDate,
        endDate: quiz.EndDate,
        timeLimit: timeLimit?.IsEnforced ? timeLimit.TimeLimitValue : null,
        attemptsAllowed: quiz.AttemptsAllowed?.IsUnlimited
          ? "Unlimited"
          : quiz.AttemptsAllowed?.NumberOfAttemptsAllowed ?? null,
        // False when the tenant refused the attempts endpoint, in which case
        // every count below is null rather than a guess of zero.
        attemptsAvailable: completedAttempts !== null,
        // New, additive field mirroring submissionStatus above: "known" is
        // completedAttempts !== null (the same condition attemptsAvailable
        // already tracks), named explicitly so a caller does not have to
        // infer "unknown" from a boolean meant for something else.
        // Adapted from JoshuaMontclair/brightspace-mcp-server (MIT).
        attemptStatus: completedAttempts !== null ? "known" : "unknown",
        ...(completedAttempts !== null ? {} : {
          attemptStatusNote:
            "Brightspace did not provide this quiz's attempt data, so it is unknown whether it was taken. " +
            "Do not report it as not attempted.",
        }),
        attemptsUsed: completedAttempts?.length ?? null,
        attemptsRemaining,
        attemptWarning,
        bestScore: completedAttempts && completedAttempts.length > 0
          ? Math.max(...completedAttempts.map((a) => a.Score ?? 0))
          : null,
        gracePeriodMinutes: quiz.SubmissionGracePeriod ?? null,
        hasPassword: Boolean(quiz.Password),
        // Additive fields, each emitted only when it has something to say.
        // availability is computed from the quiz's own start and end dates.
        ...availabilityField(quiz.StartDate, quiz.EndDate),
        // A row built from the table of contents alone: the quiz's own record
        // was refused, or the topic names no quiz id to ask for.
        ...(quiz.ContentMetadataOnly ? {
          detailsStatus: "unavailable" as const,
          detailsStatusNote: DETAILS_UNAVAILABLE_NOTE,
        } : {}),
        // The topic's IsExempt: the user is exempt from the topic. Kept
        // listed, since exempt does not mean it cannot be opened.
        ...(exempt ? { exempt: true as const } : {}),
      };

      assignments.push(quizAssignment);
  }

  // Process the gradebook last, once the fetched items are known.
  if (gradebookResult.status === "fulfilled") {
    assignments.push(
      ...gradebookHeadsUp(gradebookResult.value, assignments, courseId, baseUrl, skippedIds)
    );
  } else {
    log("DEBUG", `Failed to fetch the gradebook for course ${courseId}`, gradebookResult.reason);
  }

  return {
    assignments,
    ...quizCoverage({
      // A 404 on the list means the course has no quiz tool: answered, and empty.
      quizList: quizResult.status === "fulfilled" || (quizResult.reason as any)?.status === 404,
      content: contentResult.status !== "fulfilled"
        ? "failed"
        : contentResult.value.datesIncluded ? "full" : "dateRestricted",
      gradebook: gradebookResult.status === "fulfilled",
      contentRecovery,
    }),
  };
}

/**
 * Gradebook columns describing work that no other route already offered.
 *
 * Two rules decide what qualifies. The column must be one a student is scored
 * on, which excludes the bookkeeping types that describe the gradebook's own
 * arithmetic. And it must match no already-fetched assignment or quiz: not
 * "unlinked", which would be the wrong test, because a released midterm's
 * column IS linked, to a quiz the student's own quizzes call cannot see, and
 * that column is the entire reason this exists.
 *
 * A column with no id or no name is skipped rather than fatal: one malformed
 * row should cost its own line, not the course's other heads-up rows.
 */
function gradebookHeadsUp(
  raw: unknown,
  fetched: any[],
  courseId: number,
  baseUrl?: string,
  skippedIds: Set<number> = new Set()
): any[] {
  if (!Array.isArray(raw)) return [];

  // Fetched items, plus the hidden folders and inactive quizzes that were left
  // out on purpose: a column of one of those is not work the tool missed.
  const covered = new Set([
    ...fetched.map((item) => item.id).filter((id) => typeof id === "number"),
    ...skippedIds,
  ]);
  // A content quiz that names no id cannot be matched to its column by id, so
  // a column carrying the same title is taken to be that quiz.
  const idlessQuizTitles = new Set(
    fetched
      .filter((item) => item.type === "quiz" && item.id === null)
      .map((item) => normalizedTitle(item.name))
  );

  const rows: any[] = [];
  for (const column of raw as GradeObject[]) {
    if (!isStudentScored(column)) continue;
    if (column.IsHidden === true) continue;
    if (covered.has(column.AssociatedTool?.ToolItemId as number)) continue;
    if (typeof column.Id !== "number" || typeof column.Name !== "string") continue;
    if (idlessQuizTitles.has(normalizedTitle(column.Name))) continue;

    rows.push({
      type: "gradeOnly",
      id: column.Id,
      name: column.Name,
      // Always null: a grade column carries no due date of its own, and
      // inventing one from the column name would be a guess.
      dueDate: null,
      dueIn: null,
      url: baseUrl ? gradebookUrl(baseUrl, courseId) : null,
    });
  }
  return rows;
}

/**
 * Register get_assignments tool
 */
export function registerGetAssignments(
  server: McpServer,
  apiClient: D2LApiClient,
  config: AppConfig
): void {
  server.registerTool(
    "get_assignments",
    {
      title: "Get Assignments",
      annotations: { readOnlyHint: true },
      description:
        "Fetch assignments and quizzes for a specific course or all enrolled courses. Shows dropbox submissions and quizzes with due dates, status, and rubric info. Use this when the user asks about assignments, homework, what to submit, quizzes, or assignment details and rubrics. " +
        "Read submissionStatus/attemptStatus, not just submission/attemptsUsed, to decide whether something was turned in: some tenants deny students access to submission or attempt data, in which case the status is \"unknown\" even though submission is null or attemptsUsed is 0. Never report an \"unknown\" item as missing, unsubmitted, or not attempted - say it could not be verified and point the user to Brightspace. " +
        "Quizzes come from the quiz list, the course content, and the gradebook; each quiz row says which in source. A quiz with id null was found only as a content topic. " +
        "A quiz row with detailsStatus \"unavailable\" was shown in the course content but Brightspace would not return its details (it may be closed, not yet open, or limited to certain students), so its dates and attempts may be missing: point the user to its link. " +
        "availability (notYetOpen, open, closed) is worked out from the quiz's own start and end dates and is left out when it has none. exempt: true means Brightspace marks the user exempt from that quiz's topic; the quiz is still listed. " +
        "Each course also carries quizCoverage. \"complete\" means every quiz source answered, not that every quiz is guaranteed to be listed; \"incomplete\" means a quiz source could not be read, so the course may have quizzes not listed. " +
        "Never conclude that a quiz was missed or not taken because it is absent, and never present the listed quizzes as all of them. " +
        "A gradeOnly row named like a quiz is a quiz whose details could not be read.",
      inputSchema: GetAssignmentsSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_assignments tool called", { args });

        // Parse and validate input
        const { courseId } = GetAssignmentsSchema.parse(args);

        // Single course case
        if (courseId) {
          try {
            const inventory = await fetchCourseInventory(apiClient, courseId, config.baseUrl);

            log("INFO", `get_assignments: Retrieved ${inventory.assignments.length} assignments for course ${courseId}`);
            return toolResponse({ courseId, ...inventory });
          } catch (error) {
            // A pending sign-in is not an empty course: the routes never
            // answered, so the result says so instead of reporting zero
            // assignments as if that were a real measurement. The envelope
            // stays a success — existing callers that only read `assignments`
            // keep working — with authPending/notice added for callers that
            // want to tell "no assignments" apart from "couldn't check".
            if (isAuthUnavailable(error)) {
              log("DEBUG", `get_assignments: sign-in pending for course ${courseId}`, error);
              return toolResponse({
                courseId,
                assignments: [],
                authPending: true,
                notice:
                  "Sign-in to Brightspace is still in progress, so assignments for this course " +
                  `could not be fetched yet. ${authPendingNotice(error)} Call get_assignments again ` +
                  "once sign-in finishes.",
              });
            }
            throw error;
          }
        }

        // All courses case
        // First, fetch enrolled courses. isActive=true is the configured
        // policy, not a constant: with activeOnly off the user asked to see
        // past courses, and the server would otherwise drop them before
        // applyCourseFilter ever saw them.
        const enrollmentPath = apiClient.lp(
          `/enrollments/myenrollments/?orgUnitTypeId=3${
            config.courseFilter.activeOnly ? "&isActive=true" : ""
          }`
        );
        // myenrollments is bookmark-paged; reading only the first page hides
        // every course past it, and with it every assignment they carry.
        const enrollmentItems = await fetchAllItems<EnrollmentItem>(
          apiClient,
          enrollmentPath,
          { ttl: DEFAULT_CACHE_TTLS.enrollments }
        );

        // Apply course filter
        const filteredEnrollments = applyCourseFilter(
          enrollmentItems.map(item => ({
            id: item.OrgUnit.Id,
            name: item.OrgUnit.Name,
            code: item.OrgUnit.Code,
            isActive: item.Access.IsActive,
            canAccess: item.Access.CanAccess,
            startDate: item.Access.StartDate,
            endDate: item.Access.EndDate,
            ...item,
          })),
          config.courseFilter
        );

        // Fetch assignments for each course (handle 403s gracefully)
        const assignmentPromises = filteredEnrollments.map(async (item) => {
          try {
            const inventory = await fetchCourseInventory(apiClient, item.OrgUnit.Id, config.baseUrl);

            return {
              courseId: item.OrgUnit.Id,
              courseName: item.OrgUnit.Name,
              ...inventory,
            };
          } catch (error: any) {
            // 403 means no access (past course, etc) - log and skip
            if (error?.status === 403) {
              log(
                "DEBUG",
                `get_assignments: 403 Forbidden for course ${item.OrgUnit.Id} (${item.OrgUnit.Name}) - skipping`
              );
              return null;
            }
            // A pending sign-in only means this course's routes never
            // answered — it says nothing about the other courses, whose
            // requests may already have gone out independently. Mark this one
            // rather than failing the whole call and losing every course that
            // *did* answer.
            if (isAuthUnavailable(error)) {
              log(
                "DEBUG",
                `get_assignments: sign-in pending for course ${item.OrgUnit.Id} (${item.OrgUnit.Name})`
              );
              return {
                courseId: item.OrgUnit.Id,
                courseName: item.OrgUnit.Name,
                authPending: true as const,
                authError: error,
              };
            }
            throw error; // Re-throw other errors
          }
        });

        const results = await Promise.allSettled(assignmentPromises);
        const settled = results
          .filter(
            (r): r is PromiseFulfilledResult<any> =>
              r.status === "fulfilled" && r.value !== null
          )
          .map((r) => r.value);

        const pending = settled.filter((c) => c.authPending);
        const courses = settled
          .filter((c) => !c.authPending)
          .map(({ authPending: _authPending, authError: _authError, ...course }) => course);

        log(
          "INFO",
          `get_assignments: Retrieved assignments for ${courses.length} courses ` +
          `(out of ${enrollmentItems.length} enrolled${pending.length > 0 ? `, ${pending.length} pending sign-in` : ""})`
        );

        // Pending courses keep `assignments: []` so callers that read
        // `courses[i].assignments` still get an array; authPending marks it
        // as unchecked rather than empty.
        const response: Record<string, unknown> = {
          courses: [
            ...courses,
            ...pending.map(({ courseId, courseName }) => ({
              courseId,
              courseName,
              assignments: [],
              authPending: true as const,
            })),
          ],
        };
        if (pending.length > 0) {
          response.authPending = true;
          response.unavailableCourseIds = pending.map((c) => c.courseId);
          response.notice =
            "Sign-in to Brightspace is still in progress, so assignments for " +
            `${pending.length} course(s) (${pending.map((c) => c.courseId).join(", ")}) could not be ` +
            `fetched yet. ${authPendingNotice(pending[0].authError)} Call get_assignments again once ` +
            "sign-in finishes.";
        }
        return toolResponse(response);
      } catch (error) {
        // Temporary: log full error details to stderr for debugging
        if (error instanceof Error) {
          log("ERROR", `get_assignments failed: ${error.message}\n${error.stack}`);
        }
        return sanitizeError(error);
      }
    }
  );
}
