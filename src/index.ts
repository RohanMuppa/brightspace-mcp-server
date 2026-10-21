#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { enableStdoutGuard, log } from "./utils/logger.js";
import { guardServerProcess } from "./utils/process-guard.js";
import { loadConfig } from "./utils/config.js";
import { setActiveShortcuts } from "./utils/two-factor-shortcuts.js";
import { startUpdateChecks } from "./utils/update-checker.js";
import { configureDevActivity } from "./utils/dev-activity.js";
import { createMcpServer, createRuntime } from "./server.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
} else if (subcommand === 'doctor') {
  await import('./doctor.js');
} else {
  // ── MCP Server (default: stdio; `http`: one shared localhost server) ──
  const http = subcommand === 'http';

  // CRITICAL: Enable stdout guard IMMEDIATELY to prevent corruption of stdio transport
  enableStdoutGuard();

  // A stray exception or a closed pipe must not silently drop the client's
  // transport; see guardServerProcess.
  guardServerProcess(process, !http);

  /** Set once the HTTP server is listening; shutdown waits on it. */
  let stopHttp: (() => Promise<void>) | undefined;

  async function main(): Promise<void> {
    try {
      // Load configuration
      const config = await loadConfig();
      configureDevActivity(config.sessionDir);
      // Lets the MFA approval message mention the setup options only to users
      // who have neither turned on. Booleans only; the key is never passed.
      setActiveShortcuts({ rememberMfa: config.rememberMfa === true, keySaved: Boolean(config.totpUri) });
      log("DEBUG", "Configuration loaded", { sessionDir: config.sessionDir });

      log("INFO", "");
      log("INFO", "========================================");
      log("INFO", `  Brightspace MCP Server v${PKG_VERSION}`);
      log("INFO", "  By Rohan Muppa — ECE @ Purdue");
      log("INFO", "  github.com/rohanmuppa/brightspace-mcp-server");
      log("INFO", "========================================");
      log("INFO", "");

      // The one stdio client hears the sign-in's progress lines as logging
      // messages. The HTTP server has many clients and tells none of them;
      // see createRuntime.
      let stdioServer: McpServer | undefined;
      const runtime = createRuntime(config, PKG_VERSION, http ? undefined : (message) => {
        void stdioServer?.sendLoggingMessage({ level: "info", logger: "brightspace-auth", data: message }).catch(() => {});
      });

      // Check for updates now, then every few hours. A stdio server can stay
      // alive for days, so a boot-only check would never see a release. The
      // interval is unref'd and cannot hold the process open.
      startUpdateChecks({ transport: http ? "http" : "stdio" });

      // Log active course filter config if any filter is set
      if (config.courseFilter.includeCourseIds || config.courseFilter.excludeCourseIds || !config.courseFilter.activeOnly) {
        log("DEBUG", "Course filter config", {
          include: config.courseFilter.includeCourseIds,
          exclude: config.courseFilter.excludeCourseIds,
          activeOnly: config.courseFilter.activeOnly,
        });
      }

      if (http) {
        const { resolveHttpPort, resolveHttpToken, startHttpServer } = await import("./http-server.js");
        const running = await startHttpServer({ runtime, token: resolveHttpToken(), port: resolveHttpPort() });
        stopHttp = running.close;
        log("INFO", `Brightspace MCP Server by Rohan Muppa — shared HTTP server listening on ${running.url} (26 tools, 4 prompts registered)`);
        log("INFO", "Leave this running; every MCP client on this computer connects to that URL. Press Ctrl+C to stop.");
        return;
      }

      // Connect stdio transport
      stdioServer = createMcpServer(runtime);
      const transport = new StdioServerTransport();
      await stdioServer.connect(transport);

      log("INFO", "Brightspace MCP Server by Rohan Muppa — running on stdio (26 tools, 4 prompts registered)");
      log("INFO", "Setup: see README.md for MCP client configuration (Claude Desktop, ChatGPT Desktop, Cursor, etc.)");
    } catch (error) {
      log("ERROR", "MCP Server failed to start", error);
      process.exit(1);
    }
  }

  // Graceful shutdown. The HTTP server first answers the calls already in
  // progress (other chats may be mid-call); a second signal stops at once.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown || !stopHttp) {
      log('INFO', 'Shutting down MCP server');
      process.exit(0);
    }
    shuttingDown = true;
    log('INFO', 'Shutting down MCP server after the calls in progress finish (press Ctrl+C again to stop now)');
    void stopHttp().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  main();
}
