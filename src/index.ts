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
import { initUpdateChecker, getUpdateNotice } from "./utils/update-checker.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  registerGetMyCourses,
  registerGetUpcomingDueDates,
  registerGetMyGrades,
  registerGetAnnouncements,
  registerGetAssignments,
  registerGetAssignmentFiles,
  registerGetCourseContent,
  registerDownloadFile,
  registerGetClasslistEmails,
  registerGetRoster,
  registerGetSyllabus,
  registerGetDiscussions,
} from "./tools/index.js";

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
      const config = loadConfig();
      log("DEBUG", "Configuration loaded", { sessionDir: config.sessionDir });

      // Create MCP server instance
      const server = new McpServer({
        name: "brightspace",
        version: PKG_VERSION,
        description: "Brightspace MCP Server — by Rohan Muppa (github.com/rohanmuppa/brightspace-mcp-server)",
      });
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
      });

      // Create AuthRunner for auto-reauthentication
      const authRunner = new AuthRunner();

      // Create D2L API Client with auto-reauth support
      const apiClient = new D2LApiClient({
        baseUrl: config.baseUrl,
        tokenManager,
        onAuthExpired: () => authRunner.run(),
      });

      // Initialize API client (discover API versions)
      try {
        await apiClient.initialize();
        log("INFO", "D2L API Client initialized");
      } catch (error) {
        log("ERROR", "Failed to initialize D2L API Client", error);
        log("ERROR", "MCP server cannot start without API initialization. Exiting.");
        process.exit(1);
      }

      // Start background update check (fire and forget)
      initUpdateChecker();

      // Register check_auth tool (no input schema needed for zero-argument tool)
      server.registerTool(
        "check_auth",
        {
          title: "Check Authentication Status",
          description:
            "Check if you are authenticated with Brightspace. " +
            "Run the brightspace-auth CLI first to authenticate. " +
            "Use this when the user asks if they're logged in, if authentication is working, " +
            "or when other tools return auth errors.",
        },
        async () => {
          log("DEBUG", "check_auth tool called");

          let token = await tokenManager.getToken();

          if (!token) {
            log("INFO", "check_auth: No valid token, attempting auto-reauthentication...");

            const success = await authRunner.run();
            if (success) {
              token = await tokenManager.getToken();
            }

            if (!token) {
              log("INFO", "check_auth: Auto-reauthentication failed or produced no valid token");

              const content: Array<{ type: "text"; text: string }> = [
                {
                  type: "text",
                  text: "Not authenticated. Auto-reauthentication was attempted but failed. " +
                    "Please run `brightspace-auth` manually in your terminal to log in. " +
                    "Make sure your credentials in .env are correct and your internet connection is stable.",
                },
              ];
              const notice = getUpdateNotice();
              if (notice) content.push({ type: "text", text: notice });
              return { content };
            }

            log("INFO", "check_auth: Auto-reauthentication succeeded");
          }

          const expiresIn = Math.round((token.expiresAt - Date.now()) / 1000 / 60);
          log("INFO", `check_auth: Token valid, expires in ~${expiresIn} minutes`);

          const content: Array<{ type: "text"; text: string }> = [
            {
              type: "text",
              text: `Authenticated with Brightspace. Token expires in ~${expiresIn} minutes. Source: ${token.source}.`,
            },
          ];
          const notice = getUpdateNotice();
          if (notice) content.push({ type: "text", text: notice });
          return { content };
        }
      );

      log("DEBUG", "check_auth tool registered");

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
      registerGetMyGrades(server, apiClient, config);
      registerGetAnnouncements(server, apiClient, config);
      registerGetAssignments(server, apiClient, config);
      registerGetAssignmentFiles(server, apiClient, config.baseUrl);
      registerGetCourseContent(server, apiClient);
      registerDownloadFile(server, apiClient);
      registerGetClasslistEmails(server, apiClient);
      registerGetRoster(server, apiClient);
      registerGetSyllabus(server, apiClient);
      registerGetDiscussions(server, apiClient);
      log("DEBUG", "MCP tools registered (12 core tools, total 13 with check_auth)");

      // Connect stdio transport
      const transport = new StdioServerTransport();
      await server.connect(transport);

      log("INFO", "Brightspace MCP Server by Rohan Muppa — running on stdio (12 tools registered)");
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
