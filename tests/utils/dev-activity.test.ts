import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { configureDevActivity, devActivity, trackToolActivity, withRecoveryActivity, recoveryActivityEnvironment } from "../../src/utils/dev-activity.js";
import { registerDownloadFile } from "../../src/tools/download-file.js";
import { registerGetDropboxFolders } from "../../src/tools/get-dropbox-folders.js";
import { httpOperation } from "../../src/utils/diagnostic-fields.js";
import { ApiError, NetworkError } from "../../src/api/errors.js";
import { DownloadError } from "../../src/utils/download-errors.js";
import { errorResponse, sanitizeError } from "../../src/tools/tool-helpers.js";
import { mintAccessToken } from "../../src/auth/token-mint.js";
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
  it("records automatic code sign-in steps without the code or the enrollment", () => {
    devActivity("mfa_method_selected");
    devActivity("mfa_code_submitted", { code: "123456", totpUri: "otpauth://totp/x?secret=AAAA" } as any);
    expect(records().map(record => record.event)).toEqual(["mfa_method_selected", "mfa_code_submitted"]);
    expect(JSON.stringify(records())).not.toContain("123456");
    expect(JSON.stringify(records())).not.toContain("otpauth");
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
  it("records software versions and role only in developer mode", () => {
    configureDevActivity(root, { version: "5.0.11", role: "server" });
    expect(records()[0]).toMatchObject({ event: "run_started", version: "5.0.11", nodeVersion: process.versions.node, role: "server" });
    devActivity("run_started", { version: "private-version", nodeVersion: "private-node", role: "private-role" } as any);
    expect(JSON.stringify(records())).not.toContain("private-");
  });
  it("does not create developer records or emit their fields to stderr in normal mode", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("D2L_DEV_MODE", "false");
    configureDevActivity(root, { version: "5.0.11", role: "server" });
    devActivity("http_response", { status: 403, operation: "dropboxFeedback" });
    devActivity("mfa_remembered", { rememberMfa: "absent" });
    expect(readdirSync(root)).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
  });
  it("keeps a concise normal-mode renewal explanation without writing developer files", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("D2L_DEV_MODE", "false");
    configureDevActivity(root, { version: "5.0.11", role: "server" });
    const api = new D2LApiClient({ baseUrl: "https://example.com",
      tokenManager: { getToken: async () => null } as any, onAuthExpired: async () => false,
    });
    await expect(api.getRaw("/d2l/api/le/1.0/private-course/news/")).rejects.toBeInstanceOf(ApiError);
    expect(stderr.mock.calls.flat().join(" ")).toContain("no usable saved token");
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("private-");
    expect(readdirSync(root)).toEqual([]);
  });
  it("records typed failures even after conversion to MCP results, without messages", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await connect(s => {
      s.registerTool("denied", {}, async () => sanitizeError(new ApiError(403, "/private-path", "private-response")));
      s.registerTool("format", {}, async () => sanitizeError(new DownloadError("unsupportedType", "private-filename")));
      s.registerTool("missing", {}, async () => errorResponse("private-directory", "destinationMissing"));
      s.registerTool("offline", {}, async () => { throw new NetworkError("private-network"); });
      s.registerTool("unknown", {}, async () => errorResponse("private-unclassified"));
      s.registerTool("ok", {}, async () => ({ content: [] }));
    });
    for (const name of ["denied", "format", "missing", "offline", "unknown", "ok"]) await c.callTool({ name });
    expect(records().filter(r => r.event === "tool_finished").map(r => r.errorKind))
      .toEqual(["permissionDenied", "unsupportedFormat", "destinationMissing", "transport", "unknown", undefined]);
    expect(JSON.stringify(records())).not.toContain("private-");
  });
  it("retains known categories from real handled download and staff-only tool failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const api = {
      le: (_course: number, path: string) => path,
      get: vi.fn(async () => { throw new ApiError(403, "/private-path", "private-body"); }),
    };
    const c = await connect(s => {
      registerDownloadFile(s, api as any);
      registerGetDropboxFolders(s, api as any);
    });
    await c.callTool({ name: "download_file", arguments: { courseId: 1, topicId: 2, downloadPath: "private-relative" } });
    await c.callTool({ name: "download_file", arguments: { courseId: 1, topicId: 2, downloadPath: join(root, "private-missing") } });
    await c.callTool({ name: "get_dropbox_folders", arguments: { courseId: 1 } });
    api.get.mockResolvedValueOnce([] as never);
    await c.callTool({ name: "download_file", arguments: { courseId: 1, folderId: 2, fileId: 3 } });
    api.get.mockResolvedValueOnce([{ Id: 2, Attachments: [{ FileId: 3, Size: Number.MAX_SAFE_INTEGER }] }] as never);
    await c.callTool({ name: "download_file", arguments: { courseId: 1, folderId: 2, fileId: 3, source: "assignmentAttachment" } });
    expect(records().filter(r => r.event === "tool_finished").map(r => r.errorKind))
      .toEqual(["validation", "destinationMissing", "permissionDenied", "notFound", "tooLarge"]);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(records())).not.toContain("private-");
  });
  it.each([
    ["/content/enforced/tenant-folder/quizzes/handout.pdf", "courseFile"],
    ["/d2l/le/content/tenant-folder/dropbox/folders/handout.pdf", "webPage"],
    ["/public/quizzes/handout.pdf", "other"],
    ["/d2l/api/le/1.90/123/quizzes/", "quizList"],
    ["/d2l/api/le/1.90/123/quizzes/456", "quiz"],
    ["/d2l/api/le/1.90/123/quizzes/456/attempts/", "quizAttempts"],
    ["/d2l/api/le/1.90/123/dropbox/folders/", "dropboxFolders"],
    ["/d2l/api/le/1.90/123/dropbox/folders/456", "dropboxFolder"],
    ["/d2l/api/le/1.90/123/dropbox/folders/456/attachments/789", "dropboxAttachment"],
    ["/d2l/api/le/1.90/123/dropbox/folders/456/submissions/789/files/10/download", "submissionFile"],
    ["/d2l/api/le/1.90/123/content/topics/456/file", "contentFile"],
    ["/d2l/api/le/1.90/123/news/456/attachments/789", "newsAttachment"],
    ["/d2l/api/le/1.90/123/rubrics?objectType=Dropbox&objectId=456", "rubrics"],
    ["/d2l/api/le/1.90/123/overview", "overview"],
    ["/d2l/api/le/1.90/123/overview/attachment", "overviewAttachment"],
    ["/d2l/api/le/1.90/lti/link/123/", "ltiLinks"],
    ["/d2l/common/dialogs/quickLink/quickLink.d2l?ou=123&type=coursefile&fileId=private-name", "quickLink"],
  ])("labels existing route %s without identifiers or query values", (path, operation) => {
    devActivity("http_response", { operation: httpOperation(path + "#private-fragment") });
    expect(records()[0].operation).toBe(operation);
    expect(JSON.stringify(records())).not.toMatch(/private-|d2l\/|objectId|tenant-folder|handout\.pdf/);
  });
  it("labels optional HTTP failures by operation without turning a successful tool into an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response("private-response", {
      status: url.includes("feedback") ? 403 : 404,
    })));
    const api = new D2LApiClient({ baseUrl: "https://example.com",
      tokenManager: new TokenManager({ baseUrl: "https://example.com", envAccessToken: "private-token" }),
    });
    const c = await connect(s => s.registerTool("optional", {}, async () => {
      for (const route of ["dropbox/folders/private-id/feedback/myFeedback/", "quizzes/private-id/attempts/"]) {
        try { await api.getRaw(`/d2l/api/le/1.0/private-course/${route}?private-query`); } catch { /* optional */ }
      }
      return { content: [] };
    }));
    expect((await c.callTool({ name: "optional" })).isError).not.toBe(true);
    expect(records().filter(r => r.event === "http_response")).toMatchObject([
      { status: 403, operation: "dropboxFeedback", elapsedMs: expect.any(Number) },
      { status: 404, operation: "quizAttempts", elapsedMs: expect.any(Number) },
    ]);
    expect(records().find(r => r.event === "tool_finished").outcome).toBe("success");
    expect(JSON.stringify(records())).not.toContain("private-");
  });
  it("records a network attempt that never received HTTP headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private-network"); }));
    const api = new D2LApiClient({ baseUrl: "https://example.com", retry: { maxAttempts: 1 },
      tokenManager: new TokenManager({ baseUrl: "https://example.com", envAccessToken: "private-token" }),
    });
    await expect(api.getRaw("/d2l/api/le/1.0/private-course/news/")).rejects.toBeInstanceOf(NetworkError);
    expect(records()).toMatchObject([{ event: "http_failed", operation: "announcements", outcome: "transport" }]);
    expect(JSON.stringify(records())).not.toContain("private-");
  });
  it("distinguishes a cached result and a coalesced GET from additional HTTP requests", async () => {
    const fetcher = vi.fn(async () => new Response('{"private-result":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const api = new D2LApiClient({ baseUrl: "https://example.com",
      tokenManager: new TokenManager({ baseUrl: "https://example.com", envAccessToken: "private-token" }),
    });
    const route = "/d2l/api/le/1.0/private-course/news/";
    await Promise.all([api.get(route, { ttl: 60000 }), api.get(route, { ttl: 60000 })]);
    await api.get(route, { ttl: 60000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(records().filter(row => row.event === "http_response")).toHaveLength(1);
    expect(records().find(row => row.event === "http_coalesced")).toMatchObject({ operation: "announcements" });
    expect(records().find(row => row.event === "cache_hit")).toMatchObject({ operation: "announcements" });
    expect(JSON.stringify(records())).not.toContain("private-");
  });
  it.each([
    [401, "private-body", "http401"],
    [200, "/d2l/login?sessionExpired=1 private-body", "expiredStub"],
    [503, "private-body", "serviceUnavailable"],
    [200, "private-invalid-json", "invalidPayload"],
  ])("records token-service evidence for HTTP %s without response content", async (status, body, reason) => {
    await mintAccessToken({ baseUrl: "https://example.com", cookieHeader: "private-cookie", csrfToken: "private-csrf",
      fetchImpl: vi.fn(async () => new Response(body, { status })) as typeof fetch });
    expect(records()).toMatchObject([{ event: "token_mint_response", status, reason }]);
    expect(JSON.stringify(records())).not.toContain("private-");
  });
  it("distinguishes a token redirect from a successful mint without logging either payload", async () => {
    const mint = (response: Response) => mintAccessToken({ baseUrl: "https://example.com",
      cookieHeader: "private-cookie", csrfToken: "private-csrf", fetchImpl: vi.fn(async () => response) as typeof fetch });
    await mint(new Response("private-body", { status: 302, headers: { location: "/d2l/login?sessionExpired=1&private-query" } }));
    await mint(new Response('{"access_token":"private-new-token"}', { status: 200 }));
    expect(records()).toMatchObject([
      { event: "token_mint_response", status: 302, outcome: "sessionExpired", reason: "expiredRedirect" },
      { event: "token_mint_response", status: 200, outcome: "success" },
    ]);
    expect(records()[1]).not.toHaveProperty("reason");
    expect(JSON.stringify(records())).not.toContain("private-");
  });
  it("keeps interleaved recovery IDs separate and passes the generated ID to its child", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let firstId: string | undefined;
    const first = withRecoveryActivity(async () => {
      firstId = recoveryActivityEnvironment().D2L_DEV_RECOVERY_ID;
      devActivity("recovery_started");
      await gate;
      devActivity("recovery_finished", { outcome: "success" });
    });
    let secondId: string | undefined;
    await withRecoveryActivity(async () => {
      secondId = recoveryActivityEnvironment().D2L_DEV_RECOVERY_ID;
      devActivity("recovery_started");
      devActivity("recovery_finished", { outcome: "success" });
    });
    release(); await first;
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondId).not.toBe(firstId);
    expect(records().map(r => r.recoveryId)).toEqual([firstId, secondId, secondId, firstId]);
    vi.stubEnv("D2L_DEV_RECOVERY_ID", firstId!);
    configureDevActivity(root, { version: "5.0.11", role: "auth" });
    devActivity("mfa_code_submitted");
    expect(records().at(-1).recoveryId).toBe(firstId);
  });
  it("rejects untrusted correlation IDs and diagnostic field values", () => {
    vi.stubEnv("D2L_DEV_RECOVERY_ID", "private-env-secret");
    configureDevActivity(root, { version: "5.0.11", role: "auth" });
    devActivity("http_response", { operation: "private-path", errorKind: "private-error", ssoResult: "private-result",
      rememberMfa: "private-outcome", statePresent: "private-state" } as any);
    expect(JSON.stringify(records())).not.toContain("private-");
    expect(records().every(row => row.recoveryId === undefined)).toBe(true);
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
