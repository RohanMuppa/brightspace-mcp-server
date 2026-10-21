import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, createRuntime, type ServerRuntime } from "../../src/server.js";
import { MAX_BODY_BYTES, resolveHttpPort, resolveHttpToken, startHttpServer, type RunningHttpServer } from "../../src/http-server.js";
import { D2LApiClient } from "../../src/api/client.js";
import { currentMfaAnnouncer } from "../../src/tools/mfa-relay.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * One shared HTTP listener, several real MCP SDK clients, and a fake
 * Brightspace behind a stubbed fetch. Nothing here signs in anywhere.
 */

const BASE_URL = "https://fake-brightspace.test";
const TOKEN = "t".repeat(48);

const config: AppConfig = {
  baseUrl: BASE_URL,
  sessionDir: "unused-session-dir",
  tokenTtl: 3600,
  headless: true,
  envAccessToken: "fake-upstream-token",
  courseFilter: { activeOnly: true },
};

const enrollment = (id: number) => ({
  OrgUnit: { Id: id, Name: `Course ${id}`, Code: `C${id}` },
  Access: { ClasslistRoleName: "Student", IsActive: true, CanAccess: true, StartDate: null, EndDate: null, LastAccessed: null },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Real sockets and several clients per test: a loaded CI runner needs more
// than the 5 s default.
describe("shared localhost HTTP server", { timeout: 30_000 }, () => {
  const realFetch = globalThis.fetch;
  let upstream: string[];
  /** Replaces the fake enrollments answer for one test. */
  let enrollments: () => Promise<Response>;
  let running: RunningHttpServer | undefined;
  const clients: Client[] = [];

  beforeEach(() => {
    upstream = [];
    enrollments = async () => json({ Items: [enrollment(1), enrollment(2)], PagingInfo: { HasMoreItems: false, Bookmark: null } });
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(BASE_URL)) return realFetch(input, init);
      upstream.push(url);
      if (url === `${BASE_URL}/d2l/api/versions/`) {
        return json([{ ProductCode: "lp", LatestVersion: "1.56" }, { ProductCode: "le", LatestVersion: "1.91" }]);
      }
      if (url.includes("/enrollments/myenrollments/")) return enrollments();
      return json({ message: "not found" }, 404);
    }) as typeof fetch);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
    await running?.close();
    running = undefined;
    vi.unstubAllGlobals();
  });

  async function listen(runtime: ServerRuntime = createRuntime(config, "test")): Promise<RunningHttpServer> {
    running = await startHttpServer({ runtime, token: TOKEN, port: 0 });
    return running;
  }

  async function connect(url: string, token = TOKEN): Promise<Client> {
    const client = new Client({ name: "test-chat", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    clients.push(client);
    return client;
  }

  /** A raw request, for the headers fetch will not let a test set (Host). */
  function raw(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }) {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: options.method ?? "POST", path: options.path ?? "/mcp", headers: options.headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end(options.body);
    });
  }

  const initialize = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
  });
  const goodHeaders = (port: number): Record<string, string> => ({
    Host: `127.0.0.1:${port}`,
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  });

  it("lists exactly the tools and prompts the stdio server does, to every client, without touching Brightspace", async () => {
    const runtime = createRuntime(config, "test");
    const { url } = await listen(runtime);

    // The stdio entrypoint builds its server with the same factory.
    const stdio = new Client({ name: "stdio", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([stdio.connect(a), createMcpServer(runtime).connect(b)]);
    clients.push(stdio);
    const expectedTools = (await stdio.listTools()).tools;
    const expectedPrompts = (await stdio.listPrompts()).prompts;
    expect(expectedTools).toHaveLength(26);
    expect(expectedPrompts).toHaveLength(4);

    const chats = await Promise.all([connect(url), connect(url), connect(url)]);
    for (const chat of chats) {
      expect((await chat.listTools()).tools).toEqual(expectedTools);
      expect((await chat.listPrompts()).prompts).toEqual(expectedPrompts);
      expect(chat.getServerVersion()).toMatchObject({ name: "brightspace", version: "test" });
    }
    expect(expectedTools.find((tool) => tool.name === "get_my_courses")?.annotations?.readOnlyHint).toBe(true);
    expect(upstream).toEqual([]);
  });

  it("runs parallel calls from several clients against one shared API client", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    enrollments = async () => {
      await held;
      return json({ Items: [enrollment(7)], PagingInfo: { HasMoreItems: false, Bookmark: null } });
    };
    const { url } = await listen();
    const chats = await Promise.all([connect(url), connect(url), connect(url)]);

    const calls = chats.map((chat) => chat.callTool({ name: "get_my_courses", arguments: {} }));
    await vi.waitFor(() => expect(upstream.some((u) => u.includes("myenrollments"))).toBe(true), { timeout: 15_000 });
    release();
    const results = await Promise.all(calls);

    for (const result of results) {
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject([{ id: 7, name: "Course 7" }]);
    }
    // One version discovery and one enrollments fetch for all three chats:
    // the in-flight request and the cache are shared, not per connection.
    expect(upstream.filter((u) => u.endsWith("/versions/"))).toHaveLength(1);
    expect(upstream.filter((u) => u.includes("myenrollments"))).toHaveLength(1);

    // A later call from yet another client is answered from that cache.
    const late = await connect(url);
    expect((await late.callTool({ name: "get_my_courses", arguments: {} })).isError).not.toBe(true);
    expect(upstream.filter((u) => u.includes("myenrollments"))).toHaveLength(1);
  });

  it("announces each call's MFA challenge to that call's client only", async () => {
    // No saved session, so each call goes straight to the re-auth hook,
    // which announces a different number per call.
    const tokenManager = { getToken: async () => null } as unknown as TokenManager;
    const numbers = ["11", "22"];
    const apiClient = new D2LApiClient({
      baseUrl: BASE_URL,
      tokenManager,
      onAuthExpired: async () => {
        currentMfaAnnouncer()?.(numbers.shift());
        return false;
      },
    });
    const { url } = await listen({ config, version: "test", tokenManager, apiClient });
    const [first, second, quiet] = await Promise.all([connect(url), connect(url), connect(url)]);

    const seen: Record<string, string[]> = { first: [], second: [], quiet: [] };
    const [one, two, three] = await Promise.all([
      first.callTool({ name: "get_my_courses", arguments: {} }, undefined, { onprogress: (p) => seen.first.push(p.message ?? "") }),
      second.callTool({ name: "get_my_courses", arguments: { activeOnly: false } }, undefined, { onprogress: (p) => seen.second.push(p.message ?? "") }),
      quiet.callTool({ name: "get_server_info", arguments: {} }, undefined, { onprogress: (p) => seen.quiet.push(p.message ?? "") }),
    ]);

    expect(one.isError).toBe(true);
    expect(two.isError).toBe(true);
    expect(three.isError).not.toBe(true);
    expect(seen.first).toHaveLength(1);
    expect(seen.second).toHaveLength(1);
    expect(seen.quiet).toEqual([]);
    // Whichever call reached the hook first got 11; neither saw the other's.
    expect([seen.first[0], seen.second[0]].map((m) => m.match(/\d+/)?.[0]).sort()).toEqual(["11", "22"]);
  });

  it("keeps serving after a call fails upstream", async () => {
    enrollments = async () => json({ message: "boom" }, 500);
    const { url } = await listen();
    const chat = await connect(url);
    const failed = await chat.callTool({ name: "get_my_courses", arguments: {} });
    expect(failed.isError).toBe(true);
    expect((await chat.callTool({ name: "get_server_info", arguments: {} })).isError).not.toBe(true);
  });

  it("rejects a client without the right bearer token", async () => {
    const { url, port } = await listen();
    await expect(connect(url, "w".repeat(48))).rejects.toThrow();
    const missing = await raw(port, { headers: { ...goodHeaders(port), Authorization: "" }, body: initialize });
    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toBe("Bearer");
    const wrong = await raw(port, { headers: { ...goodHeaders(port), Authorization: `Bearer ${TOKEN}x` }, body: initialize });
    expect(wrong.status).toBe(401);
    expect(wrong.body).not.toContain(TOKEN);
  });

  it("rejects DNS-rebinding hosts and foreign web origins before anything else", async () => {
    const { port } = await listen();
    expect((await raw(port, { headers: { ...goodHeaders(port), Host: `evil.example:${port}` }, body: initialize })).status).toBe(403);
    expect((await raw(port, { headers: { ...goodHeaders(port), Host: `127.0.0.1:${port + 1}` }, body: initialize })).status).toBe(403);
    expect((await raw(port, { headers: { ...goodHeaders(port), Origin: "https://evil.example" }, body: initialize })).status).toBe(403);
    expect((await raw(port, { headers: { ...goodHeaders(port), Origin: "null" }, body: initialize })).status).toBe(403);
    // The server's own origin, and localhost, are fine.
    expect((await raw(port, { headers: { ...goodHeaders(port), Origin: `http://127.0.0.1:${port}` }, body: initialize })).status).toBe(200);
    expect((await raw(port, { headers: { ...goodHeaders(port), Host: `localhost:${port}` }, body: initialize })).status).toBe(200);
  });

  it("rejects the wrong path, method, content type, oversized and malformed bodies", async () => {
    const { port } = await listen();
    const headers = goodHeaders(port);
    expect((await raw(port, { path: "/other", headers, body: initialize })).status).toBe(404);
    const get = await raw(port, { method: "GET", headers });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
    expect((await raw(port, { method: "DELETE", headers })).status).toBe(405);
    expect((await raw(port, { headers: { ...headers, "Content-Type": "text/plain" }, body: initialize })).status).toBe(415);
    expect((await raw(port, { headers, body: Buffer.alloc(MAX_BODY_BYTES + 1, "a") })).status).toBe(413);
    expect((await raw(port, { headers, body: "{not json" })).status).toBe(400);
    // The SDK still enforces its own Accept rule.
    expect((await raw(port, { headers: { ...headers, Accept: "application/json" }, body: initialize })).status).toBe(406);
  });

  it("answers 413 to an oversized chunked body that declares no Content-Length", async () => {
    const { port } = await listen();
    const chunk = Buffer.alloc(64 * 1024, "a");
    const chunks = Math.ceil(MAX_BODY_BYTES / chunk.length) + 1;

    const response = await new Promise<{ status: number; sent: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, method: "POST", path: "/mcp", headers: { ...goodHeaders(port), "Transfer-Encoding": "chunked" } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (data) => { body += data; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, sent: req.getHeaders(), body }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      for (let i = 0; i < chunks; i++) req.write(chunk);
      req.end();
    });

    expect(response.sent["content-length"]).toBeUndefined();
    expect(chunk.length * chunks).toBeGreaterThan(MAX_BODY_BYTES);
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: `Request body exceeds ${MAX_BODY_BYTES} bytes` },
      id: null,
    });
  });

  it("refuses to bind a port that is already taken instead of starting a second copy", async () => {
    const { port } = await listen();
    await expect(startHttpServer({ runtime: createRuntime(config, "test"), token: TOKEN, port }))
      .rejects.toThrow(/already in use/);
  });

  it("finishes calls already in progress when it shuts down, and takes no new ones", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    enrollments = async () => {
      await held;
      return json({ Items: [enrollment(3)], PagingInfo: { HasMoreItems: false, Bookmark: null } });
    };
    const server = await listen();
    const chat = await connect(server.url);
    const call = chat.callTool({ name: "get_my_courses", arguments: {} });
    await vi.waitFor(() => expect(upstream.some((u) => u.includes("myenrollments"))).toBe(true), { timeout: 15_000 });

    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    running = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    await expect(raw(server.port, { headers: goodHeaders(server.port), body: initialize })).rejects.toThrow();

    release();
    const result = await call;
    expect(result.isError).not.toBe(true);
    await closing;
    expect(closed).toBe(true);
  });
});

describe("shared HTTP server settings", () => {
  it("requires a long enough bearer token and never echoes it", () => {
    expect(() => resolveHttpToken({})).toThrow(/D2L_HTTP_TOKEN is not set/);
    expect(() => resolveHttpToken({ D2L_HTTP_TOKEN: "short-secret" })).toThrow(/too short/);
    expect(() => resolveHttpToken({ D2L_HTTP_TOKEN: "short-secret" })).not.toThrow(/short-secret/);
    expect(() => resolveHttpToken({ D2L_HTTP_TOKEN: `${TOKEN}\n` })).toThrow();
    expect(resolveHttpToken({ D2L_HTTP_TOKEN: TOKEN })).toBe(TOKEN);
  });

  it("takes the port from --port, then D2L_HTTP_PORT, then the default", () => {
    expect(resolveHttpPort(["node", "index.js", "http"], {})).toBe(18765);
    expect(resolveHttpPort(["node", "index.js", "http"], { D2L_HTTP_PORT: "4000" })).toBe(4000);
    expect(resolveHttpPort(["node", "index.js", "http", "--port", "5000"], { D2L_HTTP_PORT: "4000" })).toBe(5000);
    expect(resolveHttpPort(["node", "index.js", "http", "--port=5001"], {})).toBe(5001);
    for (const bad of ["0", "70000", "abc", ""]) {
      expect(() => resolveHttpPort(["node", "index.js", "http", "--port", bad], {})).toThrow(/Invalid port/);
    }
  });
});
