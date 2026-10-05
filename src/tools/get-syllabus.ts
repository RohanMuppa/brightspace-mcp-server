/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D2LApiClient, ApiError, DEFAULT_CACHE_TTLS } from "../api/index.js";
import { GetSyllabusSchema } from "./schemas.js";
import { toolResponse, sanitizeError, errorResponse } from "./tool-helpers.js";
import { convertHtmlToMarkdown } from "../utils/html-converter.js";
import { stripD2lSessionParams } from "../utils/session-params.js";
import { secureDownload, readBodyCapped } from "../utils/download-helpers.js";
import { DownloadError } from "../utils/download-errors.js";
import { MAX_FILE_SIZE } from "../utils/file-validator.js";
import { extractPdfText } from "../utils/pdf-extractor.js";
import { log } from "../utils/logger.js";
import path from "node:path";
import fs from "node:fs/promises";

// D2L Overview API response shape
interface CourseOverview {
  Description: { Text: string; Html: string } | null;
}

// D2L content table of contents (/content/toc), trimmed to what we read
interface TocModule {
  Modules?: TocModule[];
  Topics?: { Title: string; Url?: string | null }[];
}

// D2L LtiLinkData, trimmed to what we read (Key/PlainSecret are never touched)
interface LtiLink {
  Title: string;
  Url: string;
  IsVisible: boolean;
}

interface ExternalSyllabusSource {
  title: string;
  location: "lti-link" | "content";
  url: string;
}

const SYLLABUS_PATTERN = /syllab/i;
const LTI_LAUNCH_PATTERN = /[?&]type=lti\b|\/d2l\/le\/lti\//i;

const EXTERNAL_SYLLABUS_NOTE =
  "This course links its syllabus through an external LTI tool. The server lists these sources but cannot launch LTI tools, so their contents are not included; open the link in Brightspace to read it.";

/** Launch URL without its query string, which can carry launch parameters. */
function stripQuery(url: string): string {
  return url.split(/[?#]/)[0];
}

/**
 * Pick the syllabus-related LTI sources out of the course's LTI links and
 * content tree. Pure: the caller fetches, this only decides.
 */
function findExternalSyllabusSources(
  ltiLinks: LtiLink[],
  toc: TocModule[]
): ExternalSyllabusSource[] {
  const sources: ExternalSyllabusSource[] = ltiLinks
    .filter((l) => l.IsVisible !== false && (SYLLABUS_PATTERN.test(l.Title) || SYLLABUS_PATTERN.test(l.Url)))
    .map((l) => ({ title: l.Title, location: "lti-link", url: stripQuery(l.Url) }));

  const walk = (modules: TocModule[]): void => {
    for (const m of modules) {
      for (const t of m.Topics ?? []) {
        if (t.Url && LTI_LAUNCH_PATTERN.test(t.Url) && SYLLABUS_PATTERN.test(t.Title)) {
          // Keep routing params (ou, type, rcode) so the link still opens the
          // right tool, but never echo D2L session tokens.
          sources.push({ title: t.Title, location: "content", url: stripD2lSessionParams(t.Url) });
        }
      }
      walk(m.Modules ?? []);
    }
  };
  walk(toc);
  return sources;
}

type DiscoveryLookup = "lti-links" | "content-toc";

interface UnavailableLookup {
  lookup: DiscoveryLookup;
  reason: "permission-denied" | "request-failed";
  /** HTTP status when the server answered; absent for transport failures. */
  status?: number;
}

const LOOKUP_LABELS: Record<DiscoveryLookup, string> = {
  "lti-links": "course LTI links",
  "content-toc": "course content table of contents",
};

type LookupOutcome<T> = { ok: true; value: T } | { ok: false; unavailable: UnavailableLookup };

/**
 * Run a lookup that students may not be permitted to make. A failure is
 * reported as unavailable rather than folded into "nothing found", so callers
 * can tell an empty search from one that could not be completed. Only the
 * HTTP status is kept; raw error bodies never reach the tool output.
 */
async function tryLookup<T>(lookup: DiscoveryLookup, fetch: () => Promise<T>): Promise<LookupOutcome<T>> {
  try {
    return { ok: true, value: await fetch() };
  } catch (error) {
    log("DEBUG", `get_syllabus: could not read ${LOOKUP_LABELS[lookup]}`, error);
    if (error instanceof ApiError) {
      const forbidden = error.status === 401 || error.status === 403;
      return {
        ok: false,
        unavailable: { lookup, reason: forbidden ? "permission-denied" : "request-failed", status: error.status },
      };
    }
    return { ok: false, unavailable: { lookup, reason: "request-failed" } };
  }
}

function describeUnavailable(u: UnavailableLookup): string {
  const why =
    u.reason === "permission-denied"
      ? "permission denied"
      : u.status !== undefined
        ? `request failed (HTTP ${u.status})`
        : "request failed (network error)";
  return `${LOOKUP_LABELS[u.lookup]}: ${why}`;
}

interface ExternalDiscovery {
  /** Fields merged into the tool output. Empty when discovery was complete and found nothing. */
  fields: Record<string, unknown>;
  complete: boolean;
}

async function discoverExternalSyllabusSources(
  apiClient: D2LApiClient,
  courseId: number
): Promise<ExternalDiscovery> {
  const [lti, toc] = await Promise.all([
    tryLookup("lti-links", () =>
      apiClient.get<LtiLink[]>(apiClient.leGlobal(`/lti/link/${courseId}/`), { ttl: DEFAULT_CACHE_TTLS.courseContent })
    ),
    tryLookup("content-toc", () =>
      apiClient.get<{ Modules?: TocModule[] }>(apiClient.le(courseId, "/content/toc"), { ttl: DEFAULT_CACHE_TTLS.courseContent })
    ),
  ]);
  const ltiLinks = lti.ok ? (Array.isArray(lti.value) ? lti.value : []) : [];
  const modules = toc.ok ? (toc.value?.Modules ?? []) : [];
  const sources = findExternalSyllabusSources(ltiLinks, modules);
  const unavailable = [lti, toc].flatMap((o) => (o.ok ? [] : [o.unavailable]));

  const fields: Record<string, unknown> = {};
  if (sources.length > 0) {
    fields.externalSyllabusSources = sources;
    fields.externalSyllabusNote = EXTERNAL_SYLLABUS_NOTE;
  }
  if (unavailable.length > 0) {
    fields.externalSyllabusDiscovery = {
      complete: false,
      unavailable,
      note:
        `Could not check every place an external syllabus may be linked (${unavailable.map(describeUnavailable).join("; ")}). ` +
        "Missing external sources here does not mean the course has no syllabus.",
    };
  }
  return { fields, complete: unavailable.length === 0 };
}

/**
 * Register get_syllabus tool
 */
export function registerGetSyllabus(
  server: McpServer,
  apiClient: D2LApiClient
): void {
  server.registerTool(
    "get_syllabus",
    {
      title: "Get Course Syllabus",
      description:
        "Fetch the syllabus/overview text and optional attachment for a course. Returns the course overview description as markdown. When the syllabus lives in an external LTI tool (e.g. Simple Syllabus), lists those sources in externalSyllabusSources; their contents cannot be read. If some of those lookups could not be completed (e.g. permission denied), externalSyllabusDiscovery says which, and an empty result is then not proof the course has no syllabus. If downloadPath is provided, also downloads the syllabus attachment (e.g. PDF). IMPORTANT: You MUST ask the user where they want to save the file before calling this tool with a downloadPath.",
      inputSchema: GetSyllabusSchema,
    },
    async (args: any) => {
      try {
        log("DEBUG", "get_syllabus tool called", { args });

        const { courseId, downloadPath } = GetSyllabusSchema.parse(args);

        // Validate downloadPath if provided
        if (downloadPath !== undefined) {
          if (!path.isAbsolute(downloadPath)) {
            return errorResponse(
              "Download path must be an absolute path (e.g., /Users/username/Downloads on Mac or C:\\Users\\username\\Downloads on Windows)"
            );
          }
          try {
            const stats = await fs.stat(downloadPath);
            if (!stats.isDirectory()) {
              return errorResponse(
                `Download path is not a directory: ${downloadPath}`
              );
            }
          } catch (error: any) {
            if (error?.code === "ENOENT") {
              return errorResponse(
                `Download directory does not exist: ${downloadPath}`
              );
            }
            throw error;
          }
        }

        // Fetch overview text
        let overview: CourseOverview | null = null;
        try {
          overview = await apiClient.get<CourseOverview>(
            apiClient.le(courseId, "/overview"),
            { ttl: DEFAULT_CACHE_TTLS.courseContent }
          );
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            const discovery = await discoverExternalSyllabusSources(apiClient, courseId);
            return toolResponse({
              courseId,
              description: null,
              hasAttachment: false,
              message: discovery.complete
                ? "No syllabus/overview found for this course."
                : "No course overview found, but external syllabus discovery was incomplete, so the course may still have a syllabus elsewhere.",
              ...discovery.fields,
            });
          }
          throw error;
        }

        // Convert description HTML to markdown
        const description = overview?.Description?.Html
          ? convertHtmlToMarkdown(overview.Description.Html).markdown
          : null;

        // Always attempt to fetch the attachment so we can extract PDF text
        let attachmentBuffer: Buffer | null = null;
        let attachmentFilename = "syllabus";
        let hasAttachment = false;

        try {
          const response = await apiClient.getRaw(
            apiClient.le(courseId, "/overview/attachment")
          );

          if (response.ok) {
            hasAttachment = true;

            // Check Content-Length before downloading body
            const contentLength = parseInt(
              response.headers.get("Content-Length") ?? "0",
              10
            );
            if (contentLength > MAX_FILE_SIZE) {
              return errorResponse(
                `Attachment too large (${Math.round(contentLength / 1024 / 1024)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
              );
            }

            // Get filename from Content-Disposition header
            const disposition = response.headers.get("Content-Disposition") ?? "";
            const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
            if (match?.[1]) {
              attachmentFilename = match[1].replace(/['"]/g, "");
            }

            // Download body as buffer
            // Capped read: Content-Length can be missing or understated.
            try {
              attachmentBuffer = await readBodyCapped(response, MAX_FILE_SIZE);
            } catch (error) {
              if (error instanceof DownloadError && error.kind === "tooLarge") {
                return errorResponse(
                  `Attachment too large (over ${MAX_FILE_SIZE / 1024 / 1024}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`
                );
              }
              throw error;
            }
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            hasAttachment = false;
          } else {
            log("DEBUG", "Could not fetch syllabus attachment", error);
          }
        }

        // Extract text from PDF attachment if available
        let syllabusText: string | null = null;
        let totalPages: number | undefined;
        if (attachmentBuffer && attachmentFilename.toLowerCase().endsWith(".pdf")) {
          const extracted = await extractPdfText(attachmentBuffer);
          if (extracted) {
            syllabusText = extracted.text;
            totalPages = extracted.totalPages;
          }
        }

        // Save to disk if downloadPath provided
        let download: { success: boolean; filePath?: string; fileSize?: number; mimeType?: string; error?: string } | undefined;
        if (downloadPath && attachmentBuffer) {
          try {
            const result = await secureDownload({
              targetDir: downloadPath,
              filename: attachmentFilename,
              data: attachmentBuffer,
            });
            log("INFO", `Syllabus attachment downloaded: ${result.path} (${result.size} bytes)`);
            download = {
              success: true,
              filePath: result.path,
              fileSize: result.size,
              mimeType: result.mime,
            };
          } catch (error) {
            log("ERROR", "Failed to save syllabus attachment", error);
            download = {
              success: false,
              error: "Failed to save attachment to disk.",
            };
          }
        } else if (downloadPath && !attachmentBuffer) {
          download = {
            success: false,
            error: "No attachment found for this course's syllabus.",
          };
        }

        log("INFO", `get_syllabus: Retrieved overview for course ${courseId}`);

        // Build response
        const result: Record<string, unknown> = { courseId, description };

        if (syllabusText) {
          result.syllabusText = syllabusText;
          if (totalPages) result.totalPages = totalPages;
        } else {
          result.hasAttachment = hasAttachment;
        }

        if (download) {
          result.download = download;
        }

        Object.assign(result, (await discoverExternalSyllabusSources(apiClient, courseId)).fields);

        return toolResponse(result);
      } catch (error) {
        return sanitizeError(error);
      }
    }
  );
}
