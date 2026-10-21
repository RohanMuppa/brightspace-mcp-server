/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, type ServerRuntime } from "./server.js";
import { readEnvSecret } from "./utils/config.js";
import { log } from "./utils/logger.js";

/** The only address the shared server listens on. Never a LAN interface. */
export const HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 18765;
export const MCP_PATH = "/mcp";
/** A tools/call body is a few hundred bytes; this leaves ample room. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** 32 characters of hex is 128 bits, which no one guesses. */
export const MIN_TOKEN_LENGTH = 32;

const TOKEN_HINT =
  `Set D2L_HTTP_TOKEN to a random secret of at least ${MIN_TOKEN_LENGTH} characters, for example the output of ` +
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

/**
 * The bearer token every request must carry. Required: this server answers
 * with private grades and rosters, and any local program (or web page that
 * got past the Host and Origin checks) could otherwise read them.
 */
export function resolveHttpToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = readEnvSecret(env.D2L_HTTP_TOKEN, "D2L_HTTP_TOKEN");
  if (!token) throw new Error(`D2L_HTTP_TOKEN is not set. ${TOKEN_HINT}`);
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`D2L_HTTP_TOKEN is too short. ${TOKEN_HINT}`);
  return token;
}

/** `--port N` or `--port=N`, then D2L_HTTP_PORT, then the default. */
export function resolveHttpPort(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): number {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") raw = argv[i + 1] ?? "";
    else if (argv[i].startsWith("--port=")) raw = argv[i].slice("--port=".length);
  }
  raw ??= env.D2L_HTTP_PORT || undefined;
  if (raw === undefined) return DEFAULT_HTTP_PORT;
  const port = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port ${JSON.stringify(raw)}: expected a whole number from 1 to 65535.`);
  }
  return port;
}

export interface HttpServerOptions {
  runtime: ServerRuntime;
  token: string;
  /** 0 picks a free port (tests). */
  port: number;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  server: Server;
  /**
   * Stop accepting connections and resolve once every request already in
   * progress has been answered. Calls in progress are never cut off.
   */
  close(): Promise<void>;
}

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: status === 400 ? -32700 : -32000, message }, id: null }));
}

class BodyTooLarge extends Error {}

/** The request body, refusing anything over MAX_BODY_BYTES as it arrives. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.off("data", onData);
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.once("error", reject);
  });
}

/**
 * Serve MCP over Streamable HTTP on 127.0.0.1, for every client on this
 * computer at once.
 *
 * Each POST gets its own McpServer and stateless transport, as the SDK
 * requires (a stateless transport refuses a second request), but they all
 * share the one runtime: the saved session, the single sign-in, and the API
 * cache and rate limiter. There are no MCP sessions to track. GET (a
 * standalone notification stream) and DELETE (ending a session) have nothing
 * to do in stateless mode and answer 405, which clients treat as "not
 * offered".
 *
 * Before any MCP handling, a request must name this server in Host (a web
 * page reaching 127.0.0.1 through DNS rebinding carries its own host name),
 * carry no Origin other than this server's own (a page in a browser always
 * sends one), and present the bearer token.
 */
export function startHttpServer({ runtime, token, port }: HttpServerOptions): Promise<RunningHttpServer> {
  const expectedToken = createHash("sha256").update(token).digest();
  const authorized = (header: string | undefined): boolean => {
    const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? "");
    return match !== null && timingSafeEqual(createHash("sha256").update(match[1]).digest(), expectedToken);
  };
  let allowedHosts = new Set<string>();
  let allowedOrigins = new Set<string>();
  let closing = false;
  let active = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!allowedHosts.has(req.headers.host ?? "")) return sendError(res, 403, "Forbidden: unexpected Host header");
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) return sendError(res, 403, "Forbidden: unexpected Origin header");
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH) return sendError(res, 404, "Not found");
    if (!authorized(req.headers.authorization)) {
      return sendError(res, 401, "Unauthorized: missing or wrong bearer token", { "WWW-Authenticate": "Bearer" });
    }
    if (req.method !== "POST") return sendError(res, 405, "Method not allowed", { Allow: "POST" });
    if (closing) return sendError(res, 503, "The server is shutting down", { Connection: "close" });
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") return sendError(res, 415, "Unsupported Media Type: expected application/json");

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        // Discard the rest without buffering it. Closing the socket on unread
        // data would reset it before the client reads the 413. Only a client
        // holding the token gets this far, and Node's request timeout bounds
        // a body that never ends.
        req.removeAllListeners("data");
        req.resume();
        return sendError(res, 413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
      }
      return sendError(res, 400, "Parse error: the body is not valid JSON");
    }

    const server = createMcpServer(runtime);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.once("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const httpServer = createServer((req, res) => {
    active += 1;
    res.once("close", () => {
      active -= 1;
      // A keep-alive connection that just finished its last request would
      // otherwise hold a closing server open until it timed out.
      if (closing) setImmediate(() => httpServer.closeIdleConnections());
    });
    handle(req, res).catch((error) => {
      log("ERROR", "Shared HTTP server failed to handle a request", error);
      sendError(res, 500, "Internal server error");
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE"
        ? new Error(
            `Port ${port} on ${HTTP_HOST} is already in use. If the Brightspace HTTP server is already running, ` +
            `connect to it instead of starting another; otherwise choose a different port with --port or D2L_HTTP_PORT.`,
          )
        : error);
    });
    httpServer.listen({ host: HTTP_HOST, port, exclusive: true }, () => {
      const bound = (httpServer.address() as AddressInfo).port;
      allowedHosts = new Set([`${HTTP_HOST}:${bound}`, `localhost:${bound}`]);
      allowedOrigins = new Set([`http://${HTTP_HOST}:${bound}`, `http://localhost:${bound}`]);
      httpServer.on("error", (error) => log("ERROR", "Shared HTTP server error", error));
      resolve({
        url: `http://${HTTP_HOST}:${bound}${MCP_PATH}`,
        port: bound,
        server: httpServer,
        close: () => new Promise<void>((done) => {
          closing = true;
          if (active > 0) log("INFO", `Waiting for ${active} request(s) in progress to finish`);
          httpServer.close(() => done());
          httpServer.closeIdleConnections();
        }),
      });
    });
  });
}
