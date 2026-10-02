import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import { ApiError, RateLimitError, NetworkError } from "../../src/api/errors.js";
import { TokenManager as RealTokenManager } from "../../src/auth/token-manager.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";

// Mock TokenManager
const createMockTokenManager = (): TokenManager => {
  let storedToken: TokenData | null = null;

  return {
    async getToken() {
      return storedToken;
    },
    async setToken(token: TokenData) {
      storedToken = token;
    },
    async clearToken() {
      storedToken = null;
    },
    isValid(token: TokenData) {
      return token.expiresAt > Date.now();
    },
    async needsRefresh() {
      return storedToken === null;
    },
  } as TokenManager;
};

// Mock token data
const createMockToken = (prefix: string = ""): TokenData => ({
  accessToken: `${prefix}test-token-12345678`,
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3600000,
  source: "browser" as const,
});

describe("D2LApiClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockTokenManager: TokenManager;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    // Save original fetch
    originalFetch = global.fetch;

    // Create mock fetch. A real Response carries both json() and text(); the
    // mocks below only define json(), so text() is filled in from it. Without
    // this every mock would need editing to exercise a client that reads the
    // body as text before parsing.
    mockFetch = vi.fn();
    global.fetch = (async (...args: unknown[]) => {
      const response: any = await (mockFetch as any)(...args);
      if (response && typeof response.text !== "function" && typeof response.json === "function") {
        response.text = async () => JSON.stringify(await response.json());
      }
      return response;
    }) as unknown as typeof global.fetch;

    // Create fresh token manager for each test
    mockTokenManager = createMockTokenManager();
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe("HTTPS enforcement", () => {
    it("should throw error for HTTP URLs", () => {
      expect(() => {
        new D2LApiClient({
          baseUrl: "http://purdue.brightspace.com",
          tokenManager: mockTokenManager,
        });
      }).toThrow("HTTPS is required");
    });

    it("should accept HTTPS URLs", () => {
      expect(() => {
        new D2LApiClient({
          baseUrl: "https://purdue.brightspace.com",
          tokenManager: mockTokenManager,
        });
      }).not.toThrow();
    });
  });

  describe("initialize() - version discovery", () => {
    it("should discover LP and LE versions", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      // Mock version discovery response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
          { ProductCode: "other", LatestVersion: "1.0" },
        ],
      });

      await client.initialize();

      expect(mockFetch).toHaveBeenCalledWith(
        "https://purdue.brightspace.com/d2l/api/versions/",
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": expect.stringContaining("Mozilla"),
          }),
        }),
      );

      expect(client.apiVersions).toEqual({
        lp: "1.56",
        le: "1.91",
      });
    });

    it("should throw if read before any request has discovered them", () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      expect(() => client.apiVersions).toThrow("have not been discovered yet");
    });
  });

  describe("get() - Bearer authentication", () => {
    it("should send Bearer token in Authorization header", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      // Initialize with versions
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
      });
      await client.initialize();

      // Set Bearer token
      const token = createMockToken();
      await mockTokenManager.setToken(token);

      // Mock API response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ Items: [] }),
      });

      await client.get("/d2l/api/lp/1.56/users/whoami");

      // Verify Authorization header
      expect(mockFetch).toHaveBeenCalledWith(
        "https://purdue.brightspace.com/d2l/api/lp/1.56/users/whoami",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${token.accessToken}`,
          }),
        }),
      );
    });
  });

  describe("get() - Cookie authentication", () => {
    it("should send cookie in Cookie header when token has cookie: prefix", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      // Initialize with versions
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
      });
      await client.initialize();

      // Set cookie-based token
      const cookieToken = createMockToken("cookie:");
      await mockTokenManager.setToken(cookieToken);

      // Mock API response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ Items: [] }),
      });

      await client.get("/d2l/api/lp/1.56/users/whoami");

      // Verify Cookie header (without prefix)
      expect(mockFetch).toHaveBeenCalledWith(
        "https://purdue.brightspace.com/d2l/api/lp/1.56/users/whoami",
        expect.objectContaining({
          headers: expect.objectContaining({
            Cookie: "test-token-12345678",
          }),
        }),
      );

      // Verify Authorization header NOT present
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[1].headers).not.toHaveProperty("Authorization");
    });
  });

  describe("get() - User-Agent header", () => {
    it("should identify BrightspaceMCP in authenticated requests", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      // Initialize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
      });
      await client.initialize();

      // Set token
      await mockTokenManager.setToken(createMockToken());

      // Mock API response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ Items: [] }),
      });

      await client.get("/d2l/api/lp/1.56/users/whoami");

      // Verify User-Agent
      expect(mockFetch).toHaveBeenCalledWith(
        "https://purdue.brightspace.com/d2l/api/lp/1.56/users/whoami",
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": expect.stringContaining("BrightspaceMCP"),
          }),
        }),
      );
    });
  });

  describe("get() - caching", () => {
    it("should cache responses with TTL and return cached value on second call", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      // Initialize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
      });
      await client.initialize();

      // Set token
      await mockTokenManager.setToken(createMockToken());

      // Mock API response
      const responseData = { Items: [{ id: 1 }] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => responseData,
      });

      // First call - should fetch
      const path = "/d2l/api/lp/1.56/users/whoami";
      const result1 = await client.get(path, { ttl: 60000 });

      expect(result1).toEqual(responseData);
      expect(mockFetch).toHaveBeenCalledTimes(2); // 1 for init, 1 for API call

      // Second call - should use cache
      const result2 = await client.get(path, { ttl: 60000 });

      expect(result2).toEqual(responseData);
      expect(mockFetch).toHaveBeenCalledTimes(2); // No new fetch
    });

    it("refetches for a caller whose TTL is shorter than the entry's age", async () => {
      vi.useFakeTimers();
      try {
        const client = new D2LApiClient({
          baseUrl: "https://purdue.brightspace.com",
          tokenManager: mockTokenManager,
        });

        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [
            { ProductCode: "lp", LatestVersion: "1.56" },
            { ProductCode: "le", LatestVersion: "1.91" },
          ],
        });
        await client.initialize();
        await mockTokenManager.setToken(createMockToken());

        // Two tools read this same path under two different TTLs: the forum
        // list is 30 minutes of course content to get_discussions and 10
        // minutes of due dates to get_upcoming_due_dates.
        const path = "/d2l/api/le/1.91/123456/discussions/forums/";
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [{ ForumId: 1 }],
        });
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => [{ ForumId: 2 }],
        });

        expect(await client.get(path, { ttl: 1_800_000 })).toEqual([{ ForumId: 1 }]);

        // Fifteen minutes later the entry is alive but older than ten minutes.
        await vi.advanceTimersByTimeAsync(900_000);

        expect(await client.get(path, { ttl: 600_000 })).toEqual([{ ForumId: 2 }]);
        expect(mockFetch).toHaveBeenCalledTimes(3); // 1 init + 2 API calls

        // The longer-TTL caller is served the refreshed value, not the stale one.
        expect(await client.get(path, { ttl: 1_800_000 })).toEqual([{ ForumId: 2 }]);
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should not cache when ttl not specified", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      // Initialize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
      });
      await client.initialize();

      // Set token
      await mockTokenManager.setToken(createMockToken());

      // Mock two different responses
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ Items: [{ id: 1 }] }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ Items: [{ id: 2 }] }),
      });

      // First call - no TTL
      const path = "/d2l/api/lp/1.56/users/whoami";
      const result1 = await client.get(path);
      expect(result1).toEqual({ Items: [{ id: 1 }] });

      // Second call - should fetch again
      const result2 = await client.get(path);
      expect(result2).toEqual({ Items: [{ id: 2 }] });

      expect(mockFetch).toHaveBeenCalledTimes(3); // 1 init + 2 API calls
    });
  });

  describe("get() - 401 retry logic", () => {
    it("should retry once with fresh token on 401, then succeed", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      // Initialize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
        headers: new Headers(),
      });
      await client.initialize();

      // Set initial token
      const staleToken = createMockToken();
      await mockTokenManager.setToken(staleToken);

      // Create a fresh token that will be returned on retry
      const freshToken = createMockToken();
      freshToken.accessToken = "fresh-token-87654321";

      // Mock getToken to return fresh token on second call
      let tokenCallCount = 0;
      const originalGetToken = mockTokenManager.getToken.bind(mockTokenManager);
      vi.spyOn(mockTokenManager, 'getToken').mockImplementation(async () => {
        tokenCallCount++;
        if (tokenCallCount === 1) {
          return staleToken;
        }
        return freshToken;
      });

      // First request returns 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
        headers: new Headers(),
      });

      // Second request succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
        headers: new Headers(),
      });

      // Make request - should retry and succeed
      const result = await client.get("/d2l/api/lp/1.56/users/whoami");

      expect(result).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledTimes(3); // 1 init + 1 fail + 1 success
    });

    it("should preserve session material when the API rejects a token", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      // Initialize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
        headers: new Headers(),
      });
      await client.initialize();

      // Set token
      await mockTokenManager.setToken(createMockToken());

      // Both requests return 401
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
        headers: new Headers(),
      });

      // Should throw after retry
      await expect(
        client.get("/d2l/api/lp/1.56/users/whoami"),
      ).rejects.toThrow(ApiError);

      // The mint endpoint, not an individual resource, decides cookie expiry.
      expect(await mockTokenManager.getToken()).not.toBeNull();
    });
  });

  describe("get() - 429 rate limiting", () => {
    it("should throw RateLimitError with Retry-After header", async () => {
      // Retries are covered in client-resilience.test.ts; here a single
      // attempt keeps the test from honoring the 60 second Retry-After.
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
        retry: { maxAttempts: 1 },
      });

      // Initialize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
        headers: new Headers(),
      });
      await client.initialize();

      // Set token
      await mockTokenManager.setToken(createMockToken());

      // Mock 429 response
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "60" }),
        text: async () => "Rate limited",
      });

      // Should throw RateLimitError
      await expect(
        client.get("/d2l/api/lp/1.56/users/whoami"),
      ).rejects.toThrow(RateLimitError);
    });
  });

  describe("get() - network errors", () => {
    it("should wrap fetch errors in NetworkError", async () => {
      // A network error is retryable; a single attempt keeps this test
      // about the wrapping, not the backoff.
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
        retry: { maxAttempts: 1 },
      });

      // Initialize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
        headers: new Headers(),
      });
      await client.initialize();

      // Set token
      await mockTokenManager.setToken(createMockToken());

      // Mock network error
      const networkError = new TypeError("Failed to fetch");
      mockFetch.mockRejectedValueOnce(networkError);

      // Should throw NetworkError with cause
      await expect(
        client.get("/d2l/api/lp/1.56/users/whoami"),
      ).rejects.toThrow(NetworkError);
    });
  });

  // The builders are pure string work that leaves the version as a
  // placeholder, so they need neither a network round trip nor a discovered
  // version. Substitution is a property of a request, and is covered against
  // the URL actually fetched in tests/api/lazy-init.test.ts.
  describe("path helpers", () => {
    const builderClient = () =>
      new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

    it("should build LP paths with a version placeholder", () => {
      expect(builderClient().lp("/users/whoami")).toBe("/d2l/api/lp/{lp}/users/whoami");
    });

    it("should build LE paths with a version placeholder", () => {
      expect(builderClient().le(123456, "/content/root/")).toBe(
        "/d2l/api/le/{le}/123456/content/root/",
      );
    });

    it("should build global LE paths with a version placeholder", () => {
      expect(builderClient().leGlobal("/enrollments/myenrollments/")).toBe(
        "/d2l/api/le/{le}/enrollments/myenrollments/",
      );
    });

    it("should not reach the network to build a path", () => {
      const client = builderClient();
      client.lp("/users/whoami");
      client.le(123456, "/content/root/");
      client.leGlobal("/enrollments/myenrollments/");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("raw response passthrough", () => {
    it("should return JSON response as-is without transformation", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      // Initialize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
      });
      await client.initialize();

      // Set token
      await mockTokenManager.setToken(createMockToken());

      // Mock response with various data types
      const rawResponse = {
        Items: [
          {
            Id: 123,
            Name: "<b>HTML Content</b>",
            Description: { Html: "<p>Description</p>" },
            CreatedDate: "2024-01-15T10:30:00.000Z",
            NullField: null,
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => rawResponse,
      });

      const result = await client.get("/d2l/api/lp/1.56/test");

      // Response should be identical to what API returned
      expect(result).toEqual(rawResponse);
      expect(result).toHaveProperty("Items");
    });
  });

  describe("cache management", () => {
    it("should clear all cached entries with clearCache()", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      // Initialize
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
      });
      await client.initialize();

      // Set token
      await mockTokenManager.setToken(createMockToken());

      // Cache some responses
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: "test" }),
      });

      await client.get("/path1", { ttl: 60000 });
      await client.get("/path2", { ttl: 60000 });

      expect(client.cacheSize).toBe(2);

      client.clearCache();

      expect(client.cacheSize).toBe(0);
    });
  });

  // Claude Desktop fans out tool calls in parallel and our tools fan out per
  // course, so the same path is often requested concurrently. A second
  // caller should join the first's in-flight request rather than issue its
  // own, and the cache write should happen exactly once.
  describe("get() - request coalescing", () => {
    const initVersions = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
        headers: new Headers(),
      });

    it("joins two concurrent GETs for the same path into one fetch, both resolving with the same data", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      initVersions();
      await client.initialize();
      await mockTokenManager.setToken(createMockToken());

      const responseData = { Items: [{ id: 1 }] };
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => responseData, headers: new Headers() });

      const path = "/d2l/api/lp/1.56/users/whoami";
      const [a, b] = await Promise.all([client.get(path), client.get(path)]);

      expect(a).toEqual(responseData);
      expect(b).toEqual(responseData);
      expect(mockFetch).toHaveBeenCalledTimes(2); // 1 init + 1 API call, not 2
    });

    it("issues separate fetches for two different concurrent paths", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      initVersions();
      await client.initialize();
      await mockTokenManager.setToken(createMockToken());

      mockFetch.mockImplementation(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (url.endsWith("/pathA") ? { a: 1 } : { b: 2 }),
        headers: new Headers(),
      }));

      const [a, b] = await Promise.all([client.get("/pathA"), client.get("/pathB")]);

      expect(a).toEqual({ a: 1 });
      expect(b).toEqual({ b: 2 });
      expect(mockFetch).toHaveBeenCalledTimes(3); // 1 init + 2 API calls
    });

    it("fetches again for a later call once the earlier in-flight one has completed", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      initVersions();
      await client.initialize();
      await mockTokenManager.setToken(createMockToken());

      const path = "/d2l/api/lp/1.56/users/whoami";
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ v: 1 }), headers: new Headers() });
      expect(await client.get(path)).toEqual({ v: 1 });

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ v: 2 }), headers: new Headers() });
      expect(await client.get(path)).toEqual({ v: 2 });

      expect(mockFetch).toHaveBeenCalledTimes(3); // 1 init + 2 separate API calls
    });

    it("rejects every joined caller when the in-flight request fails, and caches nothing", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
        retry: { maxAttempts: 1 },
      });

      initVersions();
      await client.initialize();
      await mockTokenManager.setToken(createMockToken());

      const path = "/d2l/api/lp/1.56/users/whoami";
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const callA = client.get(path, { ttl: 60000 });
      const callB = client.get(path, { ttl: 60000 });

      await expect(callA).rejects.toThrow(NetworkError);
      await expect(callB).rejects.toThrow(NetworkError);
      expect(client.cacheSize).toBe(0);

      // A later call retries instead of reusing a cached rejection.
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }), headers: new Headers() });
      expect(await client.get(path, { ttl: 60000 })).toEqual({ ok: true });
    });
  });

  describe("stats()", () => {
    const zeroStats = {
      statusClasses: { "2xx": 0, "401": 0, "403": 0, "404": 0, "429": 0, "5xx": 0, other: 0 },
      networkErrors: 0,
      cacheHits: 0,
      cacheMisses: 0,
      coalescedJoins: 0,
      tokenRefreshes: 0,
    };

    const initVersions = () =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
        headers: new Headers(),
      });

    it("starts at zero and never carries a URL, username, or token", () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      expect(client.stats()).toEqual(zeroStats);
    });

    it("counts responses by status class", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
        retry: { maxAttempts: 1 },
      });

      initVersions();
      await client.initialize();
      await mockTokenManager.setToken(createMockToken());

      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), headers: new Headers() });
      await client.get("/path-2xx");

      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "no", headers: new Headers() });
      await expect(client.get("/path-401")).rejects.toThrow(ApiError);

      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => "forbidden", headers: new Headers() });
      await expect(client.get("/path-403")).rejects.toThrow(ApiError);

      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => "missing", headers: new Headers() });
      await expect(client.get("/path-404")).rejects.toThrow(ApiError);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "1" }),
        text: async () => "rate limited",
      });
      await expect(client.get("/path-429")).rejects.toThrow(RateLimitError);

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom", headers: new Headers() });
      await expect(client.get("/path-5xx")).rejects.toThrow(ApiError);

      expect(client.stats().statusClasses).toEqual({
        "2xx": 1,
        "401": 1,
        "403": 1,
        "404": 1,
        "429": 1,
        "5xx": 1,
        other: 0,
      });
    });

    it("counts a network error separately from HTTP status classes", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
        retry: { maxAttempts: 1 },
      });

      initVersions();
      await client.initialize();
      await mockTokenManager.setToken(createMockToken());

      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(client.get("/flaky")).rejects.toThrow(NetworkError);

      expect(client.stats().networkErrors).toBe(1);
      expect(client.stats().statusClasses).toEqual(zeroStats.statusClasses);
    });

    it("counts cache hits and misses", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      initVersions();
      await client.initialize();
      await mockTokenManager.setToken(createMockToken());

      const path = "/cached-path";
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ v: 1 }), headers: new Headers() });
      await client.get(path, { ttl: 60000 }); // miss
      await client.get(path, { ttl: 60000 }); // hit

      expect(client.stats().cacheMisses).toBe(1);
      expect(client.stats().cacheHits).toBe(1);
    });

    it("counts a coalesced join once per joiner, not per originator", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      initVersions();
      await client.initialize();
      await mockTokenManager.setToken(createMockToken());

      const path = "/coalesced-path";
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ v: 1 }), headers: new Headers() });
      await Promise.all([client.get(path), client.get(path), client.get(path)]);

      expect(client.stats().coalescedJoins).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2); // 1 init + 1 API call
    });

    it("counts a token refresh when a 401 is recovered with a fresh token", async () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      initVersions();
      await client.initialize();

      const staleToken = createMockToken();
      await mockTokenManager.setToken(staleToken);
      const freshToken = createMockToken();
      freshToken.accessToken = "fresh-token-87654321";

      let tokenCallCount = 0;
      vi.spyOn(mockTokenManager, "getToken").mockImplementation(async () => {
        tokenCallCount++;
        return tokenCallCount === 1 ? staleToken : freshToken;
      });

      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized", headers: new Headers() });
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }), headers: new Headers() });

      await client.get("/d2l/api/lp/1.56/users/whoami");

      expect(client.stats().tokenRefreshes).toBe(1);
    });
  });

  // TokenManager already single-flights its HTTP token mint (see
  // tests/auth/token-manager.test.ts, "mints once for two concurrent
  // getToken calls"). This pins the same guarantee one layer up: two
  // concurrent client.get() calls that both hit a 401 at once must not
  // mint two tokens.
  describe("get() - concurrent 401s share one token mint (regression)", () => {
    it("joins concurrent 401 recoveries onto a single in-flight mint", async () => {
      let storedToken: TokenData | null = null;
      const sessionStore = {
        async load() {
          return storedToken;
        },
        async save(token: TokenData) {
          storedToken = token;
        },
        async clear() {
          storedToken = null;
        },
        async saveIfCurrent(token: TokenData, expected: TokenData) {
          if (JSON.stringify(storedToken) !== JSON.stringify(expected)) return false;
          storedToken = token;
          return true;
        },
        async clearIfCurrent(expected: TokenData) {
          if (JSON.stringify(storedToken) !== JSON.stringify(expected)) return false;
          storedToken = null;
          return true;
        },
      };

      let resolveMint: (value: { ok: true; accessToken: string }) => void = () => {};
      const mint = vi.fn(
        () =>
          new Promise<{ ok: true; accessToken: string }>((resolve) => {
            resolveMint = resolve;
          }),
      );

      const realTokenManager = new RealTokenManager({
        sessionStore,
        baseUrl: "https://purdue.brightspace.com",
        mint: mint as any,
      });

      const staleToken: TokenData = {
        accessToken: "stale-jwt",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        source: "browser",
        tenantOrigin: "https://purdue.brightspace.com",
        cookieHeader: "d2lSessionVal=abc",
        csrfToken: "xsrf-token",
      };
      await realTokenManager.setToken(staleToken);

      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: realTokenManager,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
        headers: new Headers(),
      });
      await client.initialize();

      mockFetch.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => {
        if (init.headers["Authorization"] === `Bearer ${staleToken.accessToken}`) {
          return { ok: false, status: 401, text: async () => "Unauthorized", headers: new Headers() };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }), headers: new Headers() };
      });

      // Two different paths, so request coalescing above never applies here —
      // this is purely about the token mint underneath two independent GETs.
      const both = Promise.all([client.get("/pathA"), client.get("/pathB")]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      resolveMint({ ok: true, accessToken: "fresh-jwt" });

      const [a, b] = await both;

      expect(mint).toHaveBeenCalledTimes(1);
      expect(a).toEqual({ ok: true });
      expect(b).toEqual({ ok: true });
    });
  });
});
