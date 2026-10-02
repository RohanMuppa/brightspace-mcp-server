/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../types/index.js";
import type { D2LApiClient } from "../api/client.js";
import { readMicrosoftSession } from "../auth/microsoft-session.js";
import { getConfigStorePath } from "../utils/config-store.js";
import { GetServerInfoSchema } from "./schemas.js";
import { toolResponse } from "./tool-helpers.js";

/**
 * Register get_server_info tool.
 *
 * Answers from the startup config alone: no network call, so it can never
 * trigger a sign-in. hasStoredCredential reflects the keychain lookup made at
 * startup, which is the credential this process actually holds.
 * microsoftSession comes from the plain summary saved beside the browser
 * state and is omitted when there is no saved state. requests is the
 * client's own lightweight counters (apiClient.stats()) — a snapshot of
 * what has happened so far this process, not a network call of its own.
 * Nothing secret — password, username, token, cookie — is ever included.
 */
export function registerGetServerInfo(
  server: McpServer,
  config: AppConfig,
  version: string,
  apiClient: Pick<D2LApiClient, "stats">
): void {
  server.registerTool(
    "get_server_info",
    {
      title: "Get Server Info",
      description:
        "Report which version of the Brightspace MCP server is running, the Node.js runtime, platform, config file path, session state directory, configured school URL, whether a credential is stored, (once a browser sign-in has been saved) what Microsoft remembered: stay-signed-in and the Don't ask again MFA checkbox, and this process's request counters (requests: responses by status class, network errors, cache hits/misses, coalesced joins, and token refreshes). Use this for troubleshooting or when the user asks which version they have. Never contacts Brightspace and never returns secrets.",
      inputSchema: GetServerInfoSchema,
    },
    async () => {
      const microsoftSession = await readMicrosoftSession(config.sessionDir);
      return toolResponse({
        version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        configPath: getConfigStorePath(),
        sessionStatePath: config.sessionDir,
        schoolUrl: config.baseUrl,
        hasStoredCredential: config.password !== undefined,
        ...(microsoftSession && { microsoftSession }),
        requests: apiClient.stats(),
      });
    }
  );
}
