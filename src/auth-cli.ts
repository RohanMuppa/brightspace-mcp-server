#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 */

import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadConfig } from "./utils/config.js";
import { BrowserAuth, TokenManager } from "./auth/index.js";

// Load .env file so credentials are available via process.env
dotenv.config({ quiet: true });

const pkgVersion = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
        "utf-8",
      ),
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

async function main(): Promise<void> {
  try {
    // Load configuration from environment
    const config = loadConfig();

    // Print header
    console.log(`\n=== Brightspace Authentication v${pkgVersion} - by Rohan Muppa ===\n`);

    // Check for credentials and provide status
    if (config.username && config.password) {
      console.log(`Authenticating as: ${config.username}`);
      console.log("Approve the sign-in request in Microsoft Authenticator when prompted.");
      console.log("If it shows a number, it is printed below: enter that number in the app.");
    } else {
      console.log("No credentials. Opening browser for manual login.");
    }

    console.log("\nStarting authentication...\n");

    // Create BrowserAuth with config
    const browserAuth = new BrowserAuth(config);

    // Authenticate and get token
    const token = await browserAuth.authenticate();

    // Create TokenManager and persist token
    const tokenManager = new TokenManager({
      sessionDir: config.sessionDir,
      baseUrl: config.baseUrl,
      tokenTtl: config.tokenTtl,
    });
    await tokenManager.setToken(token);

    // Verify session.json was actually written to disk
    const sessionFile = path.join(config.sessionDir, "session.json");
    try {
      await fs.access(sessionFile);
    } catch {
      console.error(
        `\nWARNING: session.json was not found at ${sessionFile} after save.`
      );
      console.error(
        "Token was captured but failed to persist. Retrying save..."
      );
      // Retry once — the directory should already exist from the first attempt
      await tokenManager.setToken(token);
      try {
        await fs.access(sessionFile);
        console.log("Retry succeeded — session.json saved.");
      } catch {
        console.error("Retry failed. Check directory permissions on", config.sessionDir);
        process.exit(1);
      }
    }

    // Print success
    console.log("\n=== Authentication successful! ===");
    console.log(`Session saved to ${sessionFile}`);
    console.log("\nThe MCP server will use this token automatically.");
    console.log("You can now add the server to your Claude Desktop configuration.\n");

    process.exit(0);
  } catch (error) {
    console.error("\n=== Authentication failed ===");
    console.error("\nError:", error instanceof Error ? error.message : String(error));
    console.error("\nTroubleshooting tips:");
    console.error("1. Ensure D2L_USERNAME and D2L_PASSWORD are set correctly in .env");
    console.error("2. If MFA approval failed, approve the sign-in request in Microsoft Authenticator, entering the number shown above if there was one");
    console.error("3. Check that you have a stable internet connection");
    console.error("4. A sign-in always opens a visible browser, even with D2L_HEADLESS=true, because the MFA number has to be readable");
    console.error("\nFor more details, check the error message above.\n");
    process.exit(1);
  }
}

main();
