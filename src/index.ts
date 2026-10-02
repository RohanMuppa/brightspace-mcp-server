#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { enableStdoutGuard, log } from "./utils/logger.js";
import { loadConfig } from "./utils/config.js";
import { TokenManager, AuthRunner } from "./auth/index.js";
import { D2LApiClient } from "./api/index.js";
import { startUpdateChecks } from "./utils/update-checker.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
} from "./tools/index.js";
import {
  registerWeeklyBriefingPrompt,
  registerGradeAuditPrompt,
  registerStudyPlannerPrompt,
  registerCourseSummaryPrompt,
} from "./prompts/index.js";
import { AUTH_COMMAND } from "./utils/commands.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// ── Subcommand routing (before any MCP initialization) ──────────────
const subcommand = process.argv[2];

if (subcommand === 'setup') {
  await import('./setup.js');
} else if (subcommand === 'auth') {
  await import('./auth-cli.js');
} else {
  // ── MCP Server (default) ────────────────────────────────────────────

  // CRITICAL: Enable stdout guard IMMEDIATELY to prevent corruption of stdio transport
  enableStdoutGuard();

  // Unhandled rejection handler
  process.on('unhandledRejection', (reason) => {
    log('ERROR', 'Unhandled promise rejection', reason);
  });

  async function main(): Promise<void> {
    try {
      // Load configuration
      const config = await loadConfig();
      log("DEBUG", "Configuration loaded", { sessionDir: config.sessionDir });

      // Create MCP server instance
      const server = new McpServer({
        name: "brightspace",
        version: PKG_VERSION,
        description: "Brightspace MCP Server — by Rohan Muppa (github.com/rohanmuppa/brightspace-mcp-server)",
      }, { capabilities: { logging: {} } });
      log("INFO", "");
      log("INFO", "========================================");
      log("INFO", `  Brightspace MCP Server v${PKG_VERSION}`);
      log("INFO", "  By Rohan Muppa — ECE @ Purdue");
      log("INFO", "  github.com/rohanmuppa/brightspace-mcp-server");
      log("INFO", "========================================");
      log("INFO", "");

      // Create TokenManager for reading cached tokens
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
        : new AuthRunner({
            onProgress: (message) => {
              void server.sendLoggingMessage({ level: "info", logger: "brightspace-auth", data: message }).catch(() => {});
            },
          });

      // Create D2L API Client with auto-reauth support
      const apiClient = new D2LApiClient({
        baseUrl: config.baseUrl,
        tokenManager,
        onAuthExpired: authRunner ? () => authRunner.run() : undefined,
        authExpiredMessage: config.envAccessToken
          ? "D2L_ACCESS_TOKEN was rejected by Brightspace (expired or invalid). Issue a fresh token and update the environment variable; this server does not fall back to a browser login while D2L_ACCESS_TOKEN is set."
          : config.envSessionCookie
            ? "The pasted D2L_SESSION_COOKIE has expired. Copy a fresh d2lSessionVal/d2lSecureSessionVal pair from a logged-in browser and update the environment variable; this server does not fall back to a browser login while D2L_SESSION_COOKIE is set."
            : undefined,
      });

      // Nothing here reaches Brightspace. API versions are discovered by the
      // first request that needs them, and the first request with no saved
      // session authenticates on its own (see D2LApiClient.withAuthentication).
      // A server that signed in at startup would open an MFA prompt on the
      // user's phone every time their editor restarted, whether or not they
      // ever asked about a course, and a tenant that was briefly unreachable
      // would take the whole server down with it.

      // Check for updates now, then every few hours. A stdio server can stay
      // alive for days, so a boot-only check would never see a release. The
      // interval is unref'd and cannot hold the process open.
      startUpdateChecks();

      // Log active course filter config if any filter is set
      if (config.courseFilter.includeCourseIds || config.courseFilter.excludeCourseIds || !config.courseFilter.activeOnly) {
        log("DEBUG", "Course filter config", {
          include: config.courseFilter.includeCourseIds,
          exclude: config.courseFilter.excludeCourseIds,
          activeOnly: config.courseFilter.activeOnly,
        });
      }

      // Register MCP tools
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
      registerGetServerInfo(server, config, PKG_VERSION, apiClient);
      registerSearchCourse(server, apiClient);
      log("DEBUG", "MCP tools registered (19 tools)");

      // Register MCP prompts — surfaced in clients (e.g. Claude Desktop) as a
      // picker, distinct from tools. Each one is a canned user message that
      // names our own tools by name, so a client with no idea what to ask
      // for still gets a one-click starting point.
      registerWeeklyBriefingPrompt(server);
      registerGradeAuditPrompt(server);
      registerStudyPlannerPrompt(server);
      registerCourseSummaryPrompt(server);
      log("DEBUG", "MCP prompts registered (4 prompts)");

      // Connect stdio transport
      const transport = new StdioServerTransport();
      await server.connect(transport);

      log("INFO", "Brightspace MCP Server by Rohan Muppa — running on stdio (19 tools, 4 prompts registered)");
      log("INFO", "Setup: see README.md for MCP client configuration (Claude Desktop, ChatGPT Desktop, Cursor, etc.)");
    } catch (error) {
      log("ERROR", "MCP Server failed to start", error);
      process.exit(1);
    }
  }

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('INFO', 'Shutting down MCP server');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    log('INFO', 'Shutting down MCP server');
    process.exit(0);
  });

  main();
}
