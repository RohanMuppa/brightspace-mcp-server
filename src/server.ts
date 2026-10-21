/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TokenManager, AuthRunner } from "./auth/index.js";
import { D2LApiClient } from "./api/index.js";
import { trackToolActivity } from "./utils/dev-activity.js";
import { log } from "./utils/logger.js";
import type { AppConfig } from "./types/index.js";
import {
  registerGetMyCourses,
  registerGetUpcomingDueDates,
  registerGetCalendarEvents,
  registerGetMyGrades,
  registerGetAnnouncements,
  registerGetAssignments,
  registerGetAssignmentRubric,
  registerGetAssignmentFiles,
  registerGetAnnouncementFiles,
  registerGetCourseContent,
  registerDownloadFile,
  registerGetClasslistEmails,
  registerGetRoster,
  registerGetMyGroups,
  registerGetSyllabus,
  registerGetDiscussions,
  registerGetVideoTranscript,
  registerGetServerInfo,
  registerSearchCourse,
  registerSignOut,
  registerGetDropboxFolders,
  registerGetDropboxSubmissions,
  registerGetDropboxUserSubmissions,
  registerGetDropboxFeedback,
  registerGetRubricsForObject,
  registerDownloadDropboxSubmissionFile,
  acceptOmittedArguments,
  relayMfaChallenges,
  currentMfaAnnouncer,
} from "./tools/index.js";
import {
  registerWeeklyBriefingPrompt,
  registerGradeAuditPrompt,
  registerStudyPlannerPrompt,
  registerCourseSummaryPrompt,
} from "./prompts/index.js";

/**
 * Everything one server process shares across every MCP connection it
 * serves: the saved session, the single in-flight sign-in, and the API
 * client's cache, request coalescing, and rate limiter. Over stdio there is
 * exactly one connection; over HTTP every chat shares this one object, so a
 * cold session signs in once for all of them.
 */
export interface ServerRuntime {
  config: AppConfig;
  version: string;
  tokenManager: TokenManager;
  apiClient: D2LApiClient;
  authRunner?: AuthRunner;
}

/**
 * Build the shared runtime. Nothing here reaches Brightspace: API versions
 * are discovered by the first request that needs them, and the first request
 * with no saved session authenticates on its own (see
 * D2LApiClient.withAuthentication). A server that signed in at startup would
 * open an MFA prompt on the user's phone every time their editor restarted,
 * whether or not they ever asked about a course, and a tenant that was
 * briefly unreachable would take the whole server down with it.
 *
 * onAuthProgress receives the sign-in child's progress lines. Over stdio they
 * go to the one client as logging messages; the HTTP server passes none, so
 * they reach only its own log, never a client that did not ask. Each call's
 * MFA challenge still reaches that call's client (see relayMfaChallenges).
 */
export function createRuntime(
  config: AppConfig,
  version: string,
  onAuthProgress?: (line: string) => void,
): ServerRuntime {
  const tokenManager = new TokenManager({
    sessionDir: config.sessionDir,
    baseUrl: config.baseUrl,
    tokenTtl: config.tokenTtl,
    envAccessToken: config.envAccessToken,
    envSessionCookie: config.envSessionCookie,
  });

  // D2L_ACCESS_TOKEN / D2L_SESSION_COOKIE are opt-in browser-free sign-in
  // escape hatches (Docker, headless Linux, WSL, hardware-key MFA
  // tenants). When either is set, AuthRunner is never created: there is
  // no stored credential to drive a browser login from, and a rejected
  // pasted credential should fail with a clear "paste a fresh one"
  // message rather than spawning auth-cli.
  const envAuthActive = Boolean(config.envAccessToken || config.envSessionCookie);
  const authRunner = envAuthActive
    ? undefined
    : new AuthRunner({ sessionDir: config.sessionDir, onProgress: onAuthProgress });

  // currentMfaAnnouncer() is read inside the tool call that hit the expired
  // session, so the challenge is announced to that call's client only.
  const apiClient = new D2LApiClient({
    baseUrl: config.baseUrl,
    tokenManager,
    onAuthExpired: authRunner ? () => authRunner.run(currentMfaAnnouncer()) : undefined,
    authExpiredMessage: config.envAccessToken
      ? "D2L_ACCESS_TOKEN was rejected by Brightspace (expired or invalid). Issue a fresh token and update the environment variable; this server does not fall back to a browser login while D2L_ACCESS_TOKEN is set."
      : config.envSessionCookie
        ? "The pasted D2L_SESSION_COOKIE has expired. Copy a fresh d2lSessionVal/d2lSecureSessionVal pair from a logged-in browser and update the environment variable; this server does not fall back to a browser login while D2L_SESSION_COOKIE is set."
        : undefined,
  });

  return { config, version, tokenManager, apiClient, authRunner };
}

/**
 * An MCP server with every tool and prompt registered against the shared
 * runtime. stdio builds one; the HTTP server builds one per request, which is
 * cheap (registration only) and is what the SDK's stateless transport
 * requires. All state worth keeping lives in the runtime, not here.
 */
export function createMcpServer(runtime: ServerRuntime): McpServer {
  const { config, version, tokenManager, apiClient, authRunner } = runtime;
  const server = new McpServer({
    name: "brightspace",
    version,
    description: "Brightspace MCP Server — by Rohan Muppa (github.com/rohanmuppa/brightspace-mcp-server)",
  }, { capabilities: { logging: {} } });

  // A client may leave `arguments` off a call to a tool that takes none;
  // SDK 1.26-1.31 reject that. Must run before the first registration.
  acceptOmittedArguments(server);

  // Register MCP tools. Each one, when its client sends a progress token,
  // shows an MFA challenge mid-call and waits for the approval instead of
  // asking to be called again (see relayMfaChallenges).
  relayMfaChallenges(server);
  trackToolActivity(server);
  registerGetMyCourses(server, apiClient, config);
  registerGetUpcomingDueDates(server, apiClient, config);
  registerGetCalendarEvents(server, apiClient, config);
  registerGetMyGrades(server, apiClient, config);
  registerGetAnnouncements(server, apiClient, config);
  registerGetAssignments(server, apiClient, config);
  registerGetAssignmentRubric(server, apiClient);
  registerGetAssignmentFiles(server, apiClient, config.baseUrl);
  registerGetAnnouncementFiles(server, apiClient);
  registerGetCourseContent(server, apiClient);
  registerDownloadFile(server, apiClient);
  registerGetClasslistEmails(server, apiClient);
  registerGetRoster(server, apiClient);
  registerGetMyGroups(server, apiClient);
  registerGetSyllabus(server, apiClient);
  registerGetDiscussions(server, apiClient);
  registerGetVideoTranscript(server, apiClient);
  registerGetServerInfo(server, config, version, apiClient);
  registerSearchCourse(server, apiClient);
  registerSignOut(server, config, apiClient, tokenManager, authRunner);
  // Instructor / TA dropbox tools (read-only) — 403 for a student account.
  registerGetDropboxFolders(server, apiClient);
  registerGetDropboxSubmissions(server, apiClient);
  registerGetDropboxUserSubmissions(server, apiClient);
  registerGetDropboxFeedback(server, apiClient);
  registerGetRubricsForObject(server, apiClient);
  registerDownloadDropboxSubmissionFile(server, apiClient);
  log("DEBUG", "MCP tools registered (26 tools)");

  // Register MCP prompts — surfaced in clients (e.g. Claude Desktop) as a
  // picker, distinct from tools. Each one is a canned user message that
  // names our own tools by name, so a client with no idea what to ask
  // for still gets a one-click starting point.
  registerWeeklyBriefingPrompt(server);
  registerGradeAuditPrompt(server);
  registerStudyPlannerPrompt(server);
  registerCourseSummaryPrompt(server);
  log("DEBUG", "MCP prompts registered (4 prompts)");

  return server;
}
