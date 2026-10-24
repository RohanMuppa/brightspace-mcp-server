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
import { NetworkError } from "../../src/api/errors.js";
import { errorResponse, sanitizeError } from "../../src/tools/tool-helpers.js";

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
  it("records a safe error category for returned and thrown failures without their messages", async () => {
    const c = await connect(s => {
      s.registerTool("invalid", {}, async () =>
        sanitizeError(z.object({ id: z.number() }).safeParse({ id: "private-input" }).error));
      s.registerTool("offline", {}, async () => { throw new NetworkError("private-host secret-token"); });
      s.registerTool("handwritten", {}, async () => errorResponse("private-path /Users/x"));
      s.registerTool("noFolder", {}, async () => errorResponse("Download directory does not exist: /Users/private-dir", "destination"));
      s.registerTool("ok", {}, async () => ({ content: [] }));
    });
    for (const name of ["invalid", "offline", "handwritten", "noFolder", "ok"]) await c.callTool({ name });
    const finished = records().filter(r => r.event === "tool_finished");
    expect(finished.map(r => [r.tool, r.outcome, r.errorKind])).toEqual([
      ["invalid", "error", "invalidInput"],
      ["offline", "error", "transport"],
      ["handwritten", "error", "unknown"],
      ["noFolder", "error", "destination"],
      ["ok", "success", undefined],
    ]);
    expect(JSON.stringify(records())).not.toMatch(/private-|secret-token|Users/);
  });
  it("drops an error category outside the allowlist", () => {
    devActivity("tool_finished", { outcome: "error", errorKind: "private-kind" } as any);
    expect(records()[0]).not.toHaveProperty("errorKind");
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
  it("records automatic code sign-in steps without the code or the enrollment", () => {
    devActivity("mfa_method_selected");
    devActivity("mfa_code_submitted", { code: "123456", totpUri: "otpauth://totp/x?secret=AAAA" } as any);
    expect(records().map(record => record.event)).toEqual(["mfa_method_selected", "mfa_code_submitted"]);
    expect(JSON.stringify(records())).not.toContain("123456");
    expect(JSON.stringify(records())).not.toContain("otpauth");
  });
  it("tags every event of an authentication child with the recovery id its parent passed", () => {
    vi.stubEnv("D2L_RECOVERY_ID", "11111111-1111-4111-8111-111111111111");
    configureDevActivity(root);
    devActivity("mfa_method_selected");
    devActivity("mfa_code_submitted", { recoveryId: "22222222-2222-4222-8222-222222222222" });
    expect(records().map(r => r.recoveryId)).toEqual([
      "11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"]);
  });
  it("records the parent's recovery id on its own recovery events", () => {
    devActivity("recovery_started", { recoveryId: "33333333-3333-4333-8333-333333333333" });
    devActivity("http_response", { status: 200 });
    expect(records()[0]).toMatchObject({ event: "recovery_started", recoveryId: "33333333-3333-4333-8333-333333333333" });
    expect(records()[1]).not.toHaveProperty("recoveryId");
  });
  it("drops a recovery id that is not a plain identifier", () => {
    vi.stubEnv("D2L_RECOVERY_ID", "private-secret");
    configureDevActivity(root);
    devActivity("mfa_code_submitted");
    devActivity("recovery_started", { recoveryId: "private-password" } as any);
    expect(JSON.stringify(records())).not.toContain("private-");
    expect(records()[0]).not.toHaveProperty("recoveryId");
  });
  it("records one run_started with the package version, Node version and process role, and no arguments", () => {
    vi.stubEnv("D2L_RECOVERY_ID", "44444444-4444-4444-8444-444444444444");
    configureDevActivity(root, { version: "9.8.7", role: "auth" });
    devActivity("mfa_method_selected");
    const started = records().filter(r => r.event === "run_started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ version: "9.8.7", node: process.versions.node, role: "auth",
      recoveryId: "44444444-4444-4444-8444-444444444444" });
    expect(Object.keys(started[0]).sort()).toEqual(["at", "event", "node", "pid", "recoveryId", "role", "runId", "version"]);
  });
  it("drops a run_started version or role outside the allowed shape", () => {
    configureDevActivity(root, { version: "private-version", role: "private-role" } as any);
    expect(records()[0]).toMatchObject({ event: "run_started", node: process.versions.node });
    expect(JSON.stringify(records())).not.toContain("private-");
  });
  it("writes no run_started unless dev mode is on", () => {
    vi.stubEnv("D2L_DEV_MODE", "");
    configureDevActivity(root, { version: "1.0.0", role: "server" });
    expect(readdirSync(root)).toEqual([]);
  });
  it("records an automaticPending recovery reason", () => {
    devActivity("recovery_finished", { outcome: "error", reason: "automaticPending" });
    expect(records()[0]).toMatchObject({ event: "recovery_finished", reason: "automaticPending" });
  });
  it("records a sign-in phase and its duration", () => {
    devActivity("auth_phase", { phase: "silentSso", elapsedMs: 30000 });
    expect(records()[0]).toMatchObject({ event: "auth_phase", phase: "silentSso", elapsedMs: 30000 });
  });
  it("drops a phase outside the allowlist", () => {
    devActivity("auth_phase", { phase: "private-phase", elapsedMs: 5 } as any);
    expect(records()[0]).not.toHaveProperty("phase");
    expect(JSON.stringify(records())).not.toContain("private-");
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
  it("names the operation behind each status so a partial success shows which optional read failed", async () => {
    const statuses: Record<string, number> = {
      "/d2l/api/le/1.75/6606/dropbox/folders/": 200,
      "/d2l/api/le/1.75/6606/dropbox/folders/41/submissions/mysubmissions/": 403,
      "/d2l/api/le/1.75/6606/dropbox/folders/41/feedback/myFeedback/": 404,
      "/d2l/api/le/1.75/6606/quizzes/": 403,
      "/d2l/api/le/1.75/6606/quizzes/77/attempts/": 404,
      "/d2l/api/le/1.75/6606/private-unknown/99?secret=1": 200,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response("private-response", { status: statuses[new URL(url).pathname + new URL(url).search] })));
    const api = new D2LApiClient({ baseUrl: "https://example.com",
      tokenManager: new TokenManager({ baseUrl: "https://example.com", envAccessToken: "private-token" }),
    });
    // A minute and second of 41 used to trip the ID check below on correct output.
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-01-01T12:41:41.077Z");
    const c = await connect(s => s.registerTool("get_assignments", {}, async () => {
      for (const path of Object.keys(statuses)) await api.getRaw(path).catch(() => undefined);
      return { content: [{ type: "text", text: "unknown fields" }] };
    }));
    expect((await c.callTool({ name: "get_assignments" })).isError).not.toBe(true);
    const rows = records();
    expect(rows.filter(r => r.event === "http_response").map(r => [r.operation, r.status])).toEqual([
      ["dropboxFolders", 200],
      ["dropboxSubmissions", 403],
      ["dropboxFeedback", 404],
      ["quizList", 403],
      ["quizAttempts", 404],
      ["other", 200],
    ]);
    expect(rows.find(r => r.event === "tool_finished")).toMatchObject({ outcome: "success" });
    expect(new Set(rows.map(r => r.callId)).size).toBe(1);
    // Timestamps, pids, UUIDs and timings vary per run and can contain these digits by chance.
    const responses = rows.filter(r => r.event === "http_response")
      .map(({ at, runId, pid, callId, elapsedMs, idleMs, sinceSuccessMs, ...rest }) => rest);
    expect(JSON.stringify(responses)).not.toMatch(/private-|6606|\b41\b|\b77\b|secret|\/d2l/);
    expect(JSON.stringify(rows)).not.toMatch(/private-|secret|\/d2l/);
  });
  it.each([
    ["/d2l/api/lp/1.56/users/whoami", "whoami"],
    ["/d2l/api/lp/1.56/enrollments/myenrollments/?orgUnitTypeId=3", "enrollments"],
    ["/d2l/api/le/1.75/6606/quizzes/77", "quiz"],
    ["/d2l/api/le/1.75/6606/grades/values/myGradeValues/", "grades"],
    ["/d2l/api/le/1.75/6606/content/topics/5/file", "contentFile"],
    ["/d2l/api/le/1.75/6606/rubrics?objectType=Dropbox&objectId=41", "rubrics"],
    ["/d2l/lms/dropbox/user/folder_user_view_feedback.d2l?db=41&grpid=0&ou=6606", "dropboxFeedbackPage"],
    ["/d2l/api/versions/", "versions"],
    ["/d2l/le/lti/6606/toolLaunch/4315971/533620995", "ltiLaunch"],
  ])("classifies %s as %s", async (path, operation) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const api = new D2LApiClient({ baseUrl: "https://example.com",
      tokenManager: new TokenManager({ baseUrl: "https://example.com", envAccessToken: "private-token" }),
    });
    await api.getRaw(path);
    expect(records()).toEqual([expect.objectContaining({ event: "http_response", status: 200, operation })]);
  });
  it("drops an operation outside the allowlist", () => {
    devActivity("http_response", { status: 403, operation: "/d2l/api/le/1.75/6606/private" } as any);
    expect(records()[0]).toMatchObject({ event: "http_response", status: 403 });
    expect(records()[0]).not.toHaveProperty("operation");
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
