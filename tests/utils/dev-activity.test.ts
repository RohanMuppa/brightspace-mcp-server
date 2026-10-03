import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { configureDevActivity, devActivity, trackToolActivity } from "../../src/utils/dev-activity.js";
import { currentMfaAnnouncer, relayMfaChallenges } from "../../src/tools/mfa-relay.js";
import { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";
import { D2LApiClient } from "../../src/api/client.js";

describe("dev activity", () => {
  let root: string;
  let client: Client | undefined;
  let server: McpServer | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dev-activity-"));
    vi.stubEnv("D2L_DEV_MODE", "true");
    configureDevActivity(root);
  });
  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = server = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    configureDevActivity(root);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  function records(): any[] {
    return readdirSync(join(root, "dev-activity")).flatMap(file =>
      readFileSync(join(root, "dev-activity", file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  }
  async function connect(register: (server: McpServer) => void) {
    server = new McpServer({ name: "test", version: "1" });
    relayMfaChallenges(server);
    trackToolActivity(server);
    register(server);
    client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    return client;
  }
  it.each(["", "false", "1"])("creates no log unless explicitly true (%s)", value => {
    vi.stubEnv("D2L_DEV_MODE", value);
    configureDevActivity(root);
    devActivity("mfa_observed");
    expect(readdirSync(root)).toEqual([]);
  });
  it("records idle intervals, errors and MFA progress through the real MCP transport without content", async () => {
    const c = await connect(s => {
      s.registerTool("courses", { inputSchema: { password: z.string() } }, async () => {
        devActivity("http_response", { status: 200 });
        return { content: [{ type: "text", text: "private-grade" }] };
      });
      s.registerTool("pending", {}, async () => {
        devActivity("mfa_observed");
        currentMfaAnnouncer()?.("42");
        return { content: [{ type: "text", text: "private-error" }], isError: true };
      });
      s.registerTool("throws", {}, async () => { throw new Error("secret-token"); });
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    await c.callTool({ name: "courses", arguments: { password: "private-password" } });
    clock.mockReturnValue(61000);
    const notices: string[] = [];
    await c.callTool({ name: "pending" }, undefined, { onprogress: p => notices.push(p.message ?? "") });
    await c.callTool({ name: "throws" });
    const rows = records();
    expect(rows.find(r => r.event === "tool_started" && r.tool === "pending")).toMatchObject({ idleMs: 60000, sinceSuccessMs: 60000 });
    expect(rows.filter(r => r.event === "tool_finished").map(r => r.outcome)).toEqual(["success", "error", "error"]);
    expect(rows.find(r => r.event === "mfa_observed").callId).toBe(rows.find(r => r.tool === "pending").callId);
    expect(notices[0]).toContain("42");
    expect(JSON.stringify(rows)).not.toMatch(/private-|secret-token|"42"/);
    expect(rows[0]).toHaveProperty("at");
    expect(rows[0]).toHaveProperty("runId");
  });
  it("keeps overlapping tools' authentication events correlated", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(r => { release = r; });
    let entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const c = await connect(s => {
      s.registerTool("first", {}, async () => {
        entered(); await blocked; devActivity("auth_required");
        return { content: [] };
      });
      s.registerTool("second", {}, async () => {
        devActivity("http_response", { status: 401 }); return { content: [] };
      });
    });
    const first = c.callTool({ name: "first" });
    await ready;
    await c.callTool({ name: "second" });
    release(); await first;
    expect(records().find(r => r.event === "auth_required").tool).toBe("first");
    expect(records().find(r => r.event === "http_response").tool).toBe("second");
  });
  it("drops unknown fields and invalid outcomes instead of copying arbitrary data", () => {
    devActivity("http_response", { status: 401, password: "secret", outcome: "secret", elapsedMs: NaN } as any);
    expect(records()[0]).toMatchObject({ event: "http_response", status: 401 });
    expect(JSON.stringify(records())).not.toContain("secret");
    expect(records()[0]).not.toHaveProperty("elapsedMs");
    devActivity("private-event" as any);
    expect(records()).toHaveLength(1);
  });
  it("correlates a real API client's rejected credential and recovery request to the tool", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-response", { status: 401 })));
    const api = new D2LApiClient({ baseUrl: "https://example.com",
      tokenManager: new TokenManager({ baseUrl: "https://example.com", envAccessToken: "private-token" }),
    });
    const c = await connect(s => s.registerTool("expired", {}, async () => {
      await api.getRaw("/private-course-path");
      return { content: [] };
    }));
    expect((await c.callTool({ name: "expired" })).isError).toBe(true);
    expect(records().map(r => r.event)).toEqual(["tool_started", "http_response", "auth_required", "tool_finished"]);
    expect(new Set(records().map(r => r.callId)).size).toBe(1);
    expect(JSON.stringify(records())).not.toContain("private-");
  });
  it("continues tool execution if the log directory is unwritable", async () => {
    writeFileSync(join(root, "dev-activity"), "occupied");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await connect(s => s.registerTool("ok", {}, async () => ({ content: [] })));
    expect((await c.callTool({ name: "ok" })).isError).not.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("caps the file without deleting existing logs", () => {
    devActivity("auth_required");
    const file = join(root, "dev-activity", readdirSync(join(root, "dev-activity"))[0]!);
    const full = "x".repeat(5 * 1024 * 1024);
    writeFileSync(file, full);
    devActivity("mfa_observed");
    expect(readFileSync(file, "utf8")).toBe(full);
  });
  it.each(["success", "sessionExpired", "transport"])("records HTTP token mint outcome %s without saved secrets", async outcome => {
    const stale: TokenData = { accessToken: "private-token", capturedAt: 0, expiresAt: 0, source: "browser",
      tenantOrigin: "https://example.com", cookieHeader: "private-cookie", csrfToken: "private-csrf" };
    const manager = new TokenManager({ baseUrl: "https://example.com", sessionStore: {
      load: async () => stale, save: async () => {}, clear: async () => {}, saveIfCurrent: async () => true, clearIfCurrent: async () => true,
    }, mint: async () => {
      if (outcome === "transport") throw new Error("private-error");
      return outcome === "success" ? { ok: true, accessToken: "private-new-token" } : { ok: false, reason: "sessionExpired" };
    } });
    try { await manager.getToken(); } catch { /* transport preserves session */ }
    expect(records().map(r => r.event)).toEqual(["token_mint_started", "token_mint_finished"]);
    expect(records()[1].outcome).toBe(outcome);
    expect(JSON.stringify(records())).not.toContain("private-");
  });
});
