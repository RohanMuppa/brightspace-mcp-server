import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime, type ServerRuntime } from "../../src/server.js";
import { D2LApiClient } from "../../src/api/client.js";
import { currentMfaAnnouncer } from "../../src/tools/mfa-relay.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import { runtimeDirectory, serveSharedRuntime, type SharedRuntime } from "../../src/shared-runtime.js";
import { relaySharedRuntime } from "../../src/runtime-relay.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * The default stdio command relays every chat to one shared runtime, started
 * on the first request and stopped when idle. Here each "chat" is a real SDK
 * client wired to its own relay, and "starting the runtime" runs it in this
 * process instead of spawning one. Brightspace is a stubbed fetch.
 */

const BASE_URL = "https://fake-brightspace.test";

const baseConfig = (sessionDir: string): AppConfig => ({
  baseUrl: BASE_URL,
  sessionDir,
  tokenTtl: 3600,
  headless: true,
  envAccessToken: "fake-upstream-token",
  courseFilter: { activeOnly: true },
});

const enrollment = (id: number) => ({
  OrgUnit: { Id: id, Name: `Course ${id}`, Code: `C${id}` },
  Access: { ClasslistRoleName: "Student", IsActive: true, CanAccess: true, StartDate: null, EndDate: null, LastAccessed: null },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("runtimeDirectory", () => {
  const config = baseConfig("/home/me/.d2l-session");

  it("is the same for the same settings and version, inside the session directory", () => {
    const dir = runtimeDirectory(config, "1.0.0");
    expect(runtimeDirectory({ ...config }, "1.0.0")).toBe(dir);
    expect(dir.startsWith(join("/home/me/.d2l-session", "shared-runtime"))).toBe(true);
  });

  it("differs when the version or any setting differs, so a chat never reuses a runtime built for other settings", () => {
    const dir = runtimeDirectory(config, "1.0.0");
    expect(runtimeDirectory(config, "1.0.1")).not.toBe(dir);
    expect(runtimeDirectory({ ...config, baseUrl: "https://other.test" }, "1.0.0")).not.toBe(dir);
    expect(runtimeDirectory({ ...config, envAccessToken: "another-token" }, "1.0.0")).not.toBe(dir);
    expect(runtimeDirectory({ ...config, courseFilter: { activeOnly: false } }, "1.0.0")).not.toBe(dir);
  });

  it("never puts a secret in the path", () => {
    const dir = runtimeDirectory({ ...config, password: "hunter2", envAccessToken: "secret-token" }, "1.0.0");
    expect(dir).not.toContain("hunter2");
    expect(dir).not.toContain("secret-token");
  });
});

describe("shared runtime behind the default stdio command", { timeout: 30_000 }, () => {
  const realFetch = globalThis.fetch;
  let upstream: string[];
  let enrollments: () => Promise<Response>;
  let sessionDir: string;
  let dir: string;
  let idleMs: number;
  /** Every runtime start that won and is serving. */
  let served: SharedRuntime[];
  let starts: number;
  let makeRuntime: () => ServerRuntime;
  const clients: Client[] = [];

  beforeEach(() => {
    upstream = [];
    served = [];
    starts = 0;
    idleMs = 60_000;
    makeRuntime = () => createRuntime(baseConfig(sessionDir), "test");
    sessionDir = mkdtempSync(join(tmpdir(), "bs-shared-"));
    dir = runtimeDirectory(baseConfig(sessionDir), "test");
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
    await Promise.all(served.splice(0).map((runtime) => runtime.stop()));
    vi.unstubAllGlobals();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  /** What spawning `brightspace-mcp-server runtime` does, in this process. */
  function startRuntime(): void {
    starts += 1;
    void serveSharedRuntime(makeRuntime(), { dir, idleMs }).then((runtime) => {
      if (runtime) served.push(runtime);
    });
  }

  /** One chat: an SDK client talking to its own relay, as over stdio. */
  async function chat(): Promise<Client> {
    const client = new Client({ name: "chat", version: "1" });
    const [clientSide, relaySide] = InMemoryTransport.createLinkedPair();
    await relaySharedRuntime(relaySide, { dir, startRuntime });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  const courseNames = async (client: Client) => {
    const result = await client.callTool({ name: "get_my_courses", arguments: {} });
    return JSON.stringify(result.content);
  };

  it("starts no runtime until the client sends its first message", async () => {
    const [, relaySide] = InMemoryTransport.createLinkedPair();
    await relaySharedRuntime(relaySide, { dir, startRuntime });
    await new Promise((done) => setTimeout(done, 100));
    expect(starts).toBe(0);
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });

  it("puts the wait for the shared runtime in the client's own log (#312)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = await chat();
      await client.listTools();
      const printed = spy.mock.calls.map((call) => call.join(" "));
      expect(printed.some((line) => line.includes("Startup: starting the shared runtime..."))).toBe(true);
      expect(printed.some((line) => /Startup: starting the shared runtime done in \d+ ms/.test(line))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("serves every tool through the relay, and concurrent cold starts converge on one runtime", async () => {
    const chats = await Promise.all([chat(), chat(), chat()]);
    const lists = await Promise.all(chats.map((client) => client.listTools()));
    for (const list of lists) expect(list.tools).toHaveLength(26);
    expect(served).toHaveLength(1);

    const answers = await Promise.all(chats.map(courseNames));
    for (const answer of answers) expect(answer).toContain("Course 1");
    // One runtime, so one version discovery for every chat.
    expect(upstream.filter((url) => url.endsWith("/d2l/api/versions/"))).toHaveLength(1);
    expect(served).toHaveLength(1);
  });

  it("stops after it has been idle, and starts again on a later request", async () => {
    idleMs = 300;
    const client = await chat();
    expect(await courseNames(client)).toContain("Course 1");
    // A slow machine can idle out between the client's initialize and its
    // call, so count starts from the runtime that answered, not from one.
    const first = served[served.length - 1];
    await first.stopped;
    expect(existsSync(join(dir, "state.json"))).toBe(false);
    const before = served.length;

    expect(await courseNames(client)).toContain("Course 1");
    expect(served.length).toBeGreaterThan(before);
    expect(served[served.length - 1]).not.toBe(first);
  });

  it("is not stopped for idleness while a call is still in progress", async () => {
    idleMs = 200;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    enrollments = async () => {
      await gate;
      return json({ Items: [enrollment(1)], PagingInfo: { HasMoreItems: false, Bookmark: null } });
    };
    const client = await chat();
    const answer = courseNames(client);
    await vi.waitFor(() => expect(upstream.some((url) => url.includes("myenrollments"))).toBe(true));
    await new Promise((done) => setTimeout(done, 600));
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    release();
    expect(await answer).toContain("Course 1");
    expect(served).toHaveLength(1);
  });

  it("finishes another chat's call when one chat disconnects mid-call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    enrollments = async () => {
      await gate;
      return json({ Items: [enrollment(7)], PagingInfo: { HasMoreItems: false, Bookmark: null } });
    };
    const [leaving, staying] = await Promise.all([chat(), chat()]);
    const abandoned = courseNames(leaving).catch(() => "closed");
    const kept = courseNames(staying);
    await vi.waitFor(() => expect(upstream.some((url) => url.includes("myenrollments"))).toBe(true));
    await leaving.close();
    release();
    expect(await kept).toContain("Course 7");
    expect(await abandoned).toBe("closed");
    expect(served).toHaveLength(1);
  });

  it("shows a call's MFA challenge to the client that made the call", async () => {
    const tokenManager = { getToken: async () => null } as unknown as TokenManager;
    makeRuntime = () => ({
      config: baseConfig(sessionDir),
      version: "test",
      tokenManager,
      apiClient: new D2LApiClient({
        baseUrl: BASE_URL,
        tokenManager,
        onAuthExpired: async () => {
          currentMfaAnnouncer()?.("42");
          // A real sign-in waits for the approval, well after the challenge.
          await new Promise((done) => setTimeout(done, 50));
          return false;
        },
      }),
    });
    const [asking, other] = await Promise.all([chat(), chat()]);
    const seen: Record<string, string[]> = { asking: [], other: [] };
    await Promise.all([
      asking.callTool({ name: "get_my_courses", arguments: {} }, undefined, { onprogress: (p) => seen.asking.push(p.message ?? "") }),
      other.callTool({ name: "get_server_info", arguments: {} }, undefined, { onprogress: (p) => seen.other.push(p.message ?? "") }),
    ]);
    expect(seen.asking).toHaveLength(1);
    expect(seen.asking[0]).toContain("42");
    expect(seen.other).toEqual([]);
  });

  it("replaces a runtime that died without cleaning up", async () => {
    mkdirSync(dir, { recursive: true });
    // Nothing listens on port 9 on 127.0.0.1 (discard), and the pid is gone.
    writeFileSync(join(dir, "state.json"), JSON.stringify({ pid: 2 ** 22 + 7, url: "http://127.0.0.1:9/mcp", token: "x".repeat(64) }));
    const client = await chat();
    expect(await courseNames(client)).toContain("Course 1");
    expect(served).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
    expect(state.pid).toBe(process.pid);
  });

  it("answers the call with an error when the runtime cannot be started", async () => {
    const client = new Client({ name: "chat", version: "1" });
    const [clientSide, relaySide] = InMemoryTransport.createLinkedPair();
    await relaySharedRuntime(relaySide, { dir, startRuntime: () => {}, startTimeoutMs: 300 });
    clients.push(client);
    await expect(client.connect(clientSide)).rejects.toThrow(/shared Brightspace runtime/i);
  });
});
