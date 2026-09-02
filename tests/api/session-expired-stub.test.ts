import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import { ApiError } from "../../src/api/errors.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";

/**
 * A dead D2L session does not answer 401. It answers HTTP 200 carrying an HTML
 * stub whose script redirects to /d2l/login?sessionExpired=1. Cookie-authenticated
 * requests take that path, so the marker, not the status, is the only honest
 * signal that the session is gone.
 *
 * Reading the stub as success meant JSON.parse threw and the failure surfaced as
 * a network error, which never triggers re-authentication.
 */

const EXPIRED_STUB =
  '<html><head><script>window.location.replace("/d2l/login?sessionExpired=1");</script></head></html>';

const token = (accessToken: string): TokenData => ({
  accessToken,
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser",
});

function makeTokenManager(initial: TokenData) {
  let stored: TokenData | null = initial;
  return {
    async getToken() {
      return stored;
    },
    async setToken(t: TokenData) {
      stored = t;
    },
    async clearToken() {
      stored = null;
    },
    isValid(t: TokenData) {
      return t.expiresAt > Date.now();
    },
    async needsRefresh() {
      return stored === null;
    },
    get current() {
      return stored;
    },
  } as unknown as TokenManager & { current: TokenData | null };
}

const ok = (body: string) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => body,
  json: async () => JSON.parse(body),
});

/** A client whose versions are already discovered, so no extra fetch is needed. */
async function makeClient(tokenManager: TokenManager, fetchMock: any) {
  global.fetch = fetchMock;
  const client = new D2LApiClient({
    baseUrl: "https://purdue.brightspace.com",
    tokenManager,
  });
  fetchMock.mockResolvedValueOnce(
    ok(JSON.stringify([{ ProductCode: "lp", LatestVersion: "1.62" }, { ProductCode: "le", LatestVersion: "1.96" }]))
  );
  await client.initialize();
  return client;
}

describe("the session-expired stub", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("is reported as an auth failure, not a network error", async () => {
    const tm = makeTokenManager(token("cookie:d2lSessionVal=dead"));
    const fetchMock = vi.fn();
    const client = await makeClient(tm, fetchMock);

    // Every attempt answers with the stub, including the retry.
    fetchMock.mockResolvedValue(ok(EXPIRED_STUB));

    await expect(client.get("/d2l/api/lp/1.62/users/whoami")).rejects.toMatchObject({
      status: 401,
    });
    await expect(client.get("/d2l/api/lp/1.62/users/whoami")).rejects.toBeInstanceOf(ApiError);
  });

  it("clears the stored token so the next call re-authenticates", async () => {
    const tm = makeTokenManager(token("cookie:d2lSessionVal=dead"));
    const fetchMock = vi.fn();
    const client = await makeClient(tm, fetchMock);
    fetchMock.mockResolvedValue(ok(EXPIRED_STUB));

    await expect(client.get("/d2l/api/lp/1.62/users/whoami")).rejects.toThrow();
    expect(await tm.getToken()).toBeNull();
  });

  it("triggers the auto-reauth callback when one is configured", async () => {
    const tm = makeTokenManager(token("cookie:d2lSessionVal=dead"));
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    const onAuthExpired = vi.fn(async () => {
      await tm.setToken(token("fresh-bearer-jwt"));
      return true;
    });

    const client = new D2LApiClient({
      baseUrl: "https://purdue.brightspace.com",
      tokenManager: tm,
      onAuthExpired,
    });
    fetchMock.mockResolvedValueOnce(
      ok(JSON.stringify([{ ProductCode: "lp", LatestVersion: "1.62" }, { ProductCode: "le", LatestVersion: "1.96" }]))
    );
    await client.initialize();

    // First call gets the stub; after re-auth the retry succeeds.
    fetchMock
      .mockResolvedValueOnce(ok(EXPIRED_STUB))
      .mockResolvedValueOnce(ok(JSON.stringify({ Identifier: "123" })));

    const result = await client.get<{ Identifier: string }>("/d2l/api/lp/1.62/users/whoami");

    expect(onAuthExpired).toHaveBeenCalledOnce();
    expect(result).toEqual({ Identifier: "123" });
  });

  it("does not mistake a real payload that mentions the marker for a dead session", async () => {
    const tm = makeTokenManager(token("bearer-jwt"));
    const fetchMock = vi.fn();
    const client = await makeClient(tm, fetchMock);

    // An announcement quoting the login URL is still a valid JSON payload.
    const body = JSON.stringify([
      { Id: 1, Title: "If you see sessionExpired=1, sign in again" },
    ]);
    fetchMock.mockResolvedValueOnce(ok(body));

    const result = await client.get<any[]>("/d2l/api/le/1.96/1/news/");
    expect(result).toHaveLength(1);
  });

  it("leaves ordinary JSON responses untouched", async () => {
    const tm = makeTokenManager(token("bearer-jwt"));
    const fetchMock = vi.fn();
    const client = await makeClient(tm, fetchMock);

    fetchMock.mockResolvedValueOnce(ok(JSON.stringify({ Items: [1, 2, 3] })));
    const result = await client.get<{ Items: number[] }>("/d2l/api/lp/1.62/enrollments/");
    expect(result.Items).toEqual([1, 2, 3]);
  });
});
