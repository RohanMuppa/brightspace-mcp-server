/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type Params = { arguments?: Record<string, unknown> } & Record<string, unknown>;
type Request = { params?: Params } & Record<string, unknown>;

function withArguments(request: Request): Request {
  if (request.params?.arguments !== undefined) return request;
  return { ...request, params: { ...request.params, arguments: {} } };
}

/**
 * Let a client leave `arguments` off a tools/call or prompts/get.
 *
 * The protocol makes the field optional, and some clients omit it for a tool
 * that takes nothing. MCP SDK 1.26 through 1.31 check the missing value
 * against the tool's schema as-is, so every tool whose inputs are all
 * optional (get_server_info, sign_out, get_my_courses, ...) failed with
 * "Input validation error: expected object, received undefined". SDK 1.32
 * reads a missing value as `{}`, and this does the same on every version the
 * dependency range admits. A tool with a required field still rejects the
 * call, because `{}` fails its schema.
 *
 * Call this before registering any tool or prompt: McpServer installs its
 * request handlers on the first registration, and only handlers installed
 * after this call are wrapped.
 */
export function acceptOmittedArguments(server: McpServer): void {
  const lowLevel = server.server;
  const install = lowLevel.setRequestHandler.bind(lowLevel) as (
    schema: unknown,
    handler: (request: Request, extra: unknown) => unknown
  ) => void;
  (lowLevel as unknown as { setRequestHandler: typeof install }).setRequestHandler = (schema, handler) =>
    install(
      schema,
      schema === CallToolRequestSchema || schema === GetPromptRequestSchema
        ? (request, extra) => handler(withArguments(request), extra)
        : handler
    );
}
