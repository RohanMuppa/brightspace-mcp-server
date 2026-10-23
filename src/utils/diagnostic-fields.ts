/** Closed diagnostic vocabulary: never serialize remote strings or request paths. */
import { ApiError, NetworkError } from "../api/errors.js";
import { DownloadError } from "./download-errors.js";
import { AuthError } from "./errors.js";
import { ZodError } from "zod";

export const ERROR_KINDS = ["validation", "destinationMissing", "permissionDenied", "notFound",
  "unsupportedFormat", "tooLarge", "authentication", "transport", "rateLimited", "providerBlocked", "unknown"] as const;
export type DiagnosticErrorKind = typeof ERROR_KINDS[number];

export function diagnosticErrorKind(error: unknown): DiagnosticErrorKind {
  if (error instanceof ApiError) {
    if (error.status === 401) return "authentication";
    if (error.status === 403) return "permissionDenied";
    if (error.status === 404) return "notFound";
    if (error.status === 429) return "rateLimited";
    return "unknown";
  }
  if (error instanceof NetworkError) return "transport";
  if (error instanceof DownloadError) {
    if (error.kind === "unsupportedType" || error.kind === "undetectableType") return "unsupportedFormat";
    return error.kind === "tooLarge" ? "tooLarge" : "validation";
  }
  if (error instanceof ZodError) return "validation";
  if (error instanceof AuthError) return "authentication";
  return "unknown";
}

export const HTTP_OPERATIONS = ["versions", "courses", "identity", "quizList", "quizAttempts",
  "dropboxFolders", "dropboxSubmissions", "dropboxFeedback", "grades", "content", "announcements",
  "calendar", "groups", "discussions", "classlist", "courseFile", "webPage", "other",
  "quiz", "dropboxFolder", "dropboxAttachment", "submissionFile", "contentFile",
  "newsAttachment", "rubrics", "overview", "overviewAttachment", "ltiLinks", "quickLink"] as const;

/** Only a fixed label crosses the boundary; identifiers and queries never do. */
export function httpOperation(path: string): typeof HTTP_OPERATIONS[number] {
  const route = path.split(/[?#]/, 1)[0];
  // File names may contain API nouns; classify the root route family first.
  if (/^\/content\/enforced\//.test(route)) return "courseFile";
  if (route.startsWith("/d2l/common/dialogs/quickLink/")) return "quickLink";
  if (!route.startsWith("/d2l/api/")) return route.startsWith("/d2l/") ? "webPage" : "other";
  if (/^\/d2l\/api\/versions\/?$/.test(route)) return "versions";
  if (/\/users\/whoami\/?$/.test(route)) return "identity";
  if (/\/enrollments\/myenrollments\//.test(route)) return "courses";
  if (/\/quizzes\/[^/]+\/attempts\//.test(route)) return "quizAttempts";
  if (/\/quizzes\/?$/.test(route)) return "quizList";
  if (/\/quizzes\//.test(route)) return "quiz";
  if (/\/dropbox\/folders\/[^/]+\/feedback\//.test(route)) return "dropboxFeedback";
  if (/\/dropbox\/folders\/[^/]+\/submissions\/[^/]+\/files\//.test(route)) return "submissionFile";
  if (/\/dropbox\/folders\/[^/]+\/(?:submissions|users)\//.test(route)) return "dropboxSubmissions";
  if (/\/dropbox\/folders\/[^/]+\/attachments\//.test(route)) return "dropboxAttachment";
  if (/\/dropbox\/folders\/[^/]+\/?$/.test(route)) return "dropboxFolder";
  if (/\/dropbox\/folders\//.test(route)) return "dropboxFolders";
  if (/\/grades\//.test(route)) return "grades";
  if (/\/content\/topics\/[^/]+\/file\/?$/.test(route)) return "contentFile";
  if (/\/content\//.test(route)) return "content";
  if (/\/news\/[^/]+\/attachments\//.test(route)) return "newsAttachment";
  if (/\/news\//.test(route)) return "announcements";
  if (/\/calendar\//.test(route)) return "calendar";
  if (/\/(?:groupcategories|groups)\//.test(route)) return "groups";
  if (/\/discussions\//.test(route)) return "discussions";
  if (/\/classlist\//.test(route)) return "classlist";
  if (/\/rubrics(?:\/|$)/.test(route)) return "rubrics";
  if (/\/overview\/attachment\/?$/.test(route)) return "overviewAttachment";
  if (/\/overview\/?$/.test(route)) return "overview";
  if (/\/lti\/link\//.test(route)) return "ltiLinks";
  return "other";
}
