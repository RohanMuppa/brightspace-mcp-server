import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import { ApiError, RateLimitError, NetworkError } from "../../src/api/errors.js";
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

    it("should throw if accessed before initialize()", () => {
      const client = new D2LApiClient({
        baseUrl: "https://purdue.brightspace.com",
        tokenManager: mockTokenManager,
      });

      expect(() => client.apiVersions).toThrow("not initialized");
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
    it("should send browser-like User-Agent header", async () => {
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
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Agent": expect.stringContaining("Chrome/131.0.0.0"),
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

    it("should clear token and throw after second 401", async () => {
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

      // Token should be cleared
      expect(await mockTokenManager.getToken()).toBeNull();
    });
  });

  describe("get() - 429 rate limiting", () => {
    it("should throw RateLimitError with Retry-After header", async () => {
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

      // Mock network error
      const networkError = new TypeError("Failed to fetch");
      mockFetch.mockRejectedValueOnce(networkError);

      // Should throw NetworkError with cause
      await expect(
        client.get("/d2l/api/lp/1.56/users/whoami"),
      ).rejects.toThrow(NetworkError);
    });
  });

  describe("path helpers", () => {
    it("should build LP paths correctly with lp()", async () => {
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

      expect(client.lp("/users/whoami")).toBe("/d2l/api/lp/1.56/users/whoami");
    });

    it("should build LE paths correctly with le()", async () => {
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

      expect(client.le(123456, "/content/root/")).toBe(
        "/d2l/api/le/1.91/123456/content/root/",
      );
    });

    it("should build global LE paths correctly with leGlobal()", async () => {
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

      expect(client.leGlobal("/enrollments/myenrollments/")).toBe(
        "/d2l/api/le/1.91/enrollments/myenrollments/",
      );
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
});
