/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../types/index.js";
import { getConfigStorePath } from "../utils/config-store.js";
import { GetServerInfoSchema } from "./schemas.js";
import { toolResponse } from "./tool-helpers.js";

/**
 * Register get_server_info tool.
 *
 * Answers from the startup config alone: no network call, so it can never
 * trigger a sign-in. hasStoredCredential reflects the keychain lookup made at
 * startup, which is the credential this process actually holds. Nothing
 * secret — password, username, token, cookie — is ever included.
 */
export function registerGetServerInfo(
  server: McpServer,
  config: AppConfig,
  version: string
): void {
  server.registerTool(
    "get_server_info",
    {
      title: "Get Server Info",
      description:
        "Report which version of the Brightspace MCP server is running, the Node.js runtime, platform, config file path, session state directory, configured school URL, and whether a credential is stored. Use this for troubleshooting or when the user asks which version they have. Never contacts Brightspace and never returns secrets.",
      inputSchema: GetServerInfoSchema,
    },
    async () =>
      toolResponse({
        version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        configPath: getConfigStorePath(),
        sessionStatePath: config.sessionDir,
        schoolUrl: config.baseUrl,
        hasStoredCredential: config.password !== undefined,
      })
  );
}
