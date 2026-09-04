import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import { ApiError, RateLimitError } from "../../src/api/errors.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";

/**
 * The client retries transient failures inside its own rate limiter, so a
 * retry storm can never bypass the throttle, and it never retries a 401.
 */

const VERSIONS = JSON.stringify([
  { ProductCode: "lp", LatestVersion: "1.62" },
  { ProductCode: "le", LatestVersion: "1.96" },
]);

const EXPIRED_STUB =
  '<html><head><script>window.location.replace("/d2l/login?sessionExpired=1");</script></head></html>';

function tokenManager(): TokenManager & { cleared: number } {
  let stored: TokenData | null = {
    accessToken: "bearer-jwt",
    capturedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    source: "browser",
  };
  const tm = {
    cleared: 0,
    async getToken() {
      return stored;
    },
    async setToken(t: TokenData) {
      stored = t;
    },
    async clearToken() {
      stored = null;
      tm.cleared++;
    },
    isValid(t: TokenData) {
      return t.expiresAt > Date.now();
    },
    async needsRefresh() {
      return stored === null;
    },
  };
  return tm as unknown as TokenManager & { cleared: number };
}

const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
  ok: (init.status ?? 200) < 400,
  status: init.status ?? 200,
  headers: new Headers({ "content-type": "application/json", ...(init.headers ?? {}) }),
  text: async () => JSON.stringify(body),
  json: async () => body,
});

describe("D2LApiClient resilience", () => {
  let originalFetch: typeof global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let sleep: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    sleep = vi.fn(async () => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  async function client(tm = tokenManager(), retry: Record<string, unknown> = {}) {
    const c = new D2LApiClient({
      baseUrl: "https://purdue.brightspace.com",
      tokenManager: tm,
      retry: { sleep, jitter: () => 0, ...retry },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => VERSIONS,
      json: async () => JSON.parse(VERSIONS),
    });
    await c.initialize();
    return c;
  }

  it("retries a 429 after the Retry-After the server asked for, then succeeds", async () => {
    const c = await client();
    fetchMock
      .mockResolvedValueOnce(json({}, { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(json({ Identifier: "42" }));

    const result = await c.get<{ Identifier: string }>("/d2l/api/lp/1.62/users/whoami");

    expect(result).toEqual({ Identifier: "42" });
    expect(sleep).toHaveBeenCalledWith(1000);
    // The version discovery call plus two attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("consumes a rate limiter token on every attempt, not once per call", async () => {
    const c = await client();
    const consume = vi.fn(async () => {});
    (c as unknown as { rateLimiter: { consume: unknown } }).rateLimiter.consume = consume;
    fetchMock
      .mockResolvedValueOnce(json({}, { status: 503 }))
      .mockResolvedValueOnce(json({}, { status: 503 }))
      .mockResolvedValueOnce(json({ ok: true }));

    await c.get("/d2l/api/lp/1.62/users/whoami");

    expect(consume).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const c = await client(tokenManager(), { maxAttempts: 2 });
    fetchMock
      .mockResolvedValueOnce(json({}, { status: 503 }))
      .mockResolvedValueOnce(json({}, { status: 502 }));

    await expect(c.get("/d2l/api/lp/1.62/users/whoami")).rejects.toMatchObject({ status: 502 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("still surfaces a 429 as RateLimitError when retries are exhausted", async () => {
    const c = await client(tokenManager(), { maxAttempts: 1 });
    fetchMock.mockResolvedValueOnce(json({}, { status: 429, headers: { "Retry-After": "60" } }));

    await expect(c.get("/d2l/api/lp/1.62/users/whoami")).rejects.toBeInstanceOf(RateLimitError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never retries a 401", async () => {
    const tm = tokenManager();
    const c = await client(tm);
    fetchMock.mockResolvedValue(json({}, { status: 401 }));

    await expect(c.get("/d2l/api/lp/1.62/users/whoami")).rejects.toMatchObject({ status: 401 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never retries a 404 on a download", async () => {
    const c = await client();
    fetchMock.mockResolvedValueOnce(json({}, { status: 404 }));

    await expect(c.getRaw("/d2l/api/le/1.96/1/content/topics/9/file")).rejects.toMatchObject({
      status: 404,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe("the session-expired stub on downloads", () => {
    it("is treated as a 401 and clears the token", async () => {
      const tm = tokenManager();
      const c = await client(tm, { maxAttempts: 1 });
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => EXPIRED_STUB,
      });

      await expect(c.getRaw("/d2l/api/le/1.96/1/content/topics/9/file")).rejects.toMatchObject({
        status: 401,
      });
      expect(tm.cleared).toBeGreaterThan(0);
    });

    it("leaves a real binary download untouched and unbuffered", async () => {
      const c = await client();
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      const text = vi.fn(async () => "should not be read");
      const response = {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/pdf" }),
        text,
        arrayBuffer: async () => bytes.buffer,
      };
      fetchMock.mockResolvedValueOnce(response);

      const result = await c.getRaw("/d2l/api/le/1.96/1/content/topics/9/file");

      expect(result).toBe(response);
      expect(text).not.toHaveBeenCalled();
    });

    it("returns a legitimate HTML page with its body intact", async () => {
      const c = await client();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "text/html" }),
        text: async () => "<html><body>Syllabus</body></html>",
      });

      const result = await c.getRaw("/d2l/api/le/1.96/1/overview/attachment");

      expect(result.status).toBe(200);
      expect(await result.text()).toContain("Syllabus");
    });
  });

  describe("base URL validation", () => {
    it("rejects http with the established message", () => {
      expect(
        () => new D2LApiClient({ baseUrl: "http://purdue.brightspace.com", tokenManager: tokenManager() })
      ).toThrow("HTTPS is required");
    });

    it("rejects a base URL that does not parse", () => {
      expect(
        () => new D2LApiClient({ baseUrl: "purdue.brightspace.com", tokenManager: tokenManager() })
      ).toThrow(/base URL/i);
    });

    it("rejects a non-http scheme", () => {
      expect(
        () => new D2LApiClient({ baseUrl: "ftp://purdue.brightspace.com", tokenManager: tokenManager() })
      ).toThrow("HTTPS is required");
    });
  });
});

describe("TTLCache timers", () => {
  it("do not keep the event loop alive", async () => {
    const { TTLCache } = await import("../../src/api/cache.js");
    const spy = vi.spyOn(global, "setTimeout");
    const cache = new TTLCache();
    cache.set("k", 1, 60_000);
    const timer = spy.mock.results[spy.mock.results.length - 1]?.value as { hasRef?: () => boolean };
    expect(typeof timer.hasRef).toBe("function");
    expect(timer.hasRef!()).toBe(false);
    cache.clear();
    spy.mockRestore();
  });
});
