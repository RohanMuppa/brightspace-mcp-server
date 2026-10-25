#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 */

import { enableStdoutGuard, log } from "./utils/logger.js";
import { guardServerProcess } from "./utils/process-guard.js";
import { loadConfig } from "./utils/config.js";
import { startupPhase } from "./utils/startup-phase.js";
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
const COMMANDS = ['setup', 'auth', 'doctor', 'repair', 'http', 'runtime'];

// A mistyped command (`htp`) must not quietly start a stdio server that sits
// waiting on stdin. Flags alone still mean the default stdio server.
if (subcommand !== undefined && !subcommand.startsWith('-') && !COMMANDS.includes(subcommand)) {
  process.stderr.write(
    `Unknown command: ${subcommand}\n\n` +
    'Usage: brightspace-mcp-server [command]\n\n' +
    'Commands:\n' +
    '  (none)   run the MCP server on stdio (what MCP clients launch)\n' +
    '  http     run one shared MCP server on localhost\n' +
    '  setup    configure your school and sign-in\n' +
    '  auth     sign in to Brightspace now\n' +
    '  doctor   check the install and configuration\n' +
    '  repair   restore and verify this installation\'s Chromium\n',
  );
  process.exit(2);
}

if (subcommand === 'setup') {
  await import('./setup.js');
} else if (subcommand === 'auth') {
  await import('./auth-cli.js');
} else if (subcommand === 'doctor') {
  await import('./doctor.js');
} else if (subcommand === 'repair') {
  await (await import('./repair.js')).main();
} else {
  // ── MCP Server ──────────────────────────────────────────────────────
  // default: stdio, relayed to the one shared runtime, started on demand;
  // `runtime <dir>`: that shared runtime (started by the default command);
  // `http`: one shared localhost server the user runs and connects to by URL.
  const mode = subcommand === 'http' ? 'http' : subcommand === 'runtime' ? 'runtime' : 'stdio';

  // CRITICAL: Enable stdout guard IMMEDIATELY to prevent corruption of stdio transport
  enableStdoutGuard();

  // A stray exception or a closed pipe must not silently drop the client's
  // transport; see guardServerProcess.
  guardServerProcess(process, mode === 'stdio');

  /** Set once the HTTP server or shared runtime is listening; shutdown waits on it. */
  let stopServing: (() => Promise<void>) | undefined;

  async function main(): Promise<void> {
    try {
      // Announce startup before any await: loading the configuration reads the
      // OS credential store, which can stall, and a client that times out
      // needs these timestamped lines to see where. No account details.
      log("INFO", `Brightspace MCP Server v${PKG_VERSION} starting (Node ${process.version}, ${process.platform}, ${mode})`);
      // The relay leaves the credential store to the runtime; see loadConfig.
      const config = await startupPhase("loading configuration", () => loadConfig({ credentials: mode !== "stdio" }));
      log("DEBUG", "Configuration loaded", { sessionDir: config.sessionDir });

      log("INFO", "");
      log("INFO", "========================================");
      log("INFO", `  Brightspace MCP Server v${PKG_VERSION}`);
      log("INFO", "  By Rohan Muppa — ECE @ Purdue");
      log("INFO", "  github.com/rohanmuppa/brightspace-mcp-server");
      log("INFO", "========================================");
      log("INFO", "");

      if (mode === 'stdio') {
        // Every MCP client on this computer that launches this command with
        // the same settings shares one runtime: one sign-in, one cache, one
        // rate limiter. The first request starts it; it stops when idle.
        // Each chat runs one of these, so it loads only the relay, never the
        // tools, API client or browser code the runtime itself needs.
        const { runtimeDirectory } = await import("./shared-runtime.js");
        const { relaySharedRuntime, spawnSharedRuntime, stdioLines } = await import("./runtime-relay.js");
        const dir = runtimeDirectory(config, PKG_VERSION);
        await relaySharedRuntime(stdioLines(), { dir, startRuntime: () => spawnSharedRuntime(__filename, dir) });
        log("INFO", "Brightspace MCP Server by Rohan Muppa — running on stdio, sharing one Brightspace runtime with this computer's other MCP clients");
        log("INFO", "Setup: see README.md for MCP client configuration (Claude Desktop, ChatGPT Desktop, Cursor, etc.)");
        return;
      }

      const { configureDevActivity } = await import("./utils/dev-activity.js");
      const { setActiveShortcuts } = await import("./utils/two-factor-shortcuts.js");
      const { startUpdateChecks } = await import("./utils/update-checker.js");
      const { createRuntime } = await import("./server.js");
      configureDevActivity(config.sessionDir, { version: PKG_VERSION, role: "server" });
      // Lets the MFA approval message mention the setup options only to users
      // who have neither turned on. Booleans only; the key is never passed.
      setActiveShortcuts({ rememberMfa: config.rememberMfa === true, keySaved: Boolean(config.totpUri) });

      // Both serve many clients, so the sign-in's progress lines go to this
      // process's log and to none of them; see createRuntime. Each call's MFA
      // challenge still reaches the client that made the call.
      const runtime = createRuntime(config, PKG_VERSION);

      // Check for updates now, then every few hours. A server can stay alive
      // for days, so a boot-only check would never see a release. The
      // interval is unref'd and cannot hold the process open.
      startUpdateChecks({ transport: mode === "http" ? "http" : "stdio" });

      // Log active course filter config if any filter is set
      if (config.courseFilter.includeCourseIds || config.courseFilter.excludeCourseIds || !config.courseFilter.activeOnly) {
        log("DEBUG", "Course filter config", {
          include: config.courseFilter.includeCourseIds,
          exclude: config.courseFilter.excludeCourseIds,
          activeOnly: config.courseFilter.activeOnly,
        });
      }

      if (mode === 'runtime') {
        const { DEFAULT_IDLE_MS, runtimeDirectory, serveSharedRuntime } = await import("./shared-runtime.js");
        const idleSeconds = Number(process.env.D2L_RUNTIME_IDLE_SECONDS);
        const idleMs = Number.isFinite(idleSeconds) && idleSeconds > 0 ? idleSeconds * 1000 : DEFAULT_IDLE_MS;
        const dir = process.argv[3] ?? runtimeDirectory(config, PKG_VERSION);
        const shared = await serveSharedRuntime(runtime, { dir, idleMs });
        if (!shared) {
          log("INFO", "Another shared runtime is already serving these settings; exiting");
          process.exit(0);
        }
        stopServing = shared.stop;
        log("INFO", `Shared runtime listening on ${shared.address.url} (pid ${process.pid}); stops after ${Math.round(idleMs / 1000)}s idle`);
        await shared.stopped;
        process.exit(0);
      }

      const { resolveHttpPort, resolveHttpToken, startHttpServer } = await import("./http-server.js");
      const running = await startHttpServer({ runtime, token: resolveHttpToken(), port: resolveHttpPort() });
      stopServing = running.close;
      log("INFO", `Brightspace MCP Server by Rohan Muppa — shared HTTP server listening on ${running.url} (26 tools, 4 prompts registered)`);
      log("INFO", "Leave this running; every MCP client on this computer connects to that URL. Press Ctrl+C to stop.");
    } catch (error) {
      log("ERROR", "MCP Server failed to start", error);
      process.exit(1);
    }
  }

  // Graceful shutdown. A server shared by other chats first answers the
  // calls already in progress; a second signal stops at once.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown || !stopServing) {
      log('INFO', 'Shutting down MCP server');
      process.exit(0);
    }
    shuttingDown = true;
    log('INFO', 'Shutting down MCP server after the calls in progress finish (press Ctrl+C again to stop now)');
    void stopServing().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  main();
}
