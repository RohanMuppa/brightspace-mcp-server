/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { D2LApiClientOptions, ApiVersions, CacheTTLs, TokenData } from "./types.js";
import { DEFAULT_CACHE_TTLS } from "./types.js";
import { TTLCache } from "./cache.js";
import { TokenBucket } from "./rate-limiter.js";
import { discoverVersions } from "./version-discovery.js";
import { ApiError, RateLimitError, NetworkError } from "./errors.js";
import { withRetry, isRetryableFailure, retryAfterMsFrom, type RetryConfig } from "./retry.js";
import { log } from "../utils/logger.js";

/**
 * The marker in the HTML stub a dead session gets instead of a payload. D2L
 * answers HTTP 200 on that path, so the status alone cannot detect it.
 */
const EXPIRED_SESSION_MARKER = "sessionExpired=1";

/**
 * D2L API client with authentication, caching, rate limiting, and version discovery.
 *
 * Key features:
 * - Auto-discovers LP/LE versions from /d2l/api/versions/
 * - Supports both Bearer tokens and cookie-based auth (auto-detected via "cookie:" prefix)
 * - Client-side rate limiting using token bucket algorithm
 * - In-memory response caching with per-data-type TTLs
 * - 401 retry logic: retry once with fresh token, then clear and throw
 * - HTTPS-only enforcement
 * - Browser-like User-Agent for requests
 * - Raw response passthrough (no transformation)
 */
export class D2LApiClient {
  private readonly baseUrl: string;
  private readonly tokenManager: D2LApiClientOptions["tokenManager"];
  private readonly cache: TTLCache;
  private readonly rateLimiter: TokenBucket;
  private readonly cacheTTLs: CacheTTLs;
  private readonly timeoutMs: number;
  private readonly onAuthExpired?: () => Promise<boolean>;
  private readonly retryConfig: RetryConfig;
  private versions: ApiVersions | null = null;

  constructor(options: D2LApiClientOptions) {
    // HTTPS-only enforcement, on a parsed URL rather than a string prefix so
    // a malformed base cannot slip through as "not http".
    let parsedBase: URL;
    try {
      parsedBase = new URL(options.baseUrl);
    } catch {
      throw new Error(`Invalid D2L base URL: ${options.baseUrl}`);
    }
    if (parsedBase.protocol !== "https:") {
      throw new Error(
        "HTTPS is required for D2L API client. HTTP URLs are not allowed for security reasons.",
      );
    }

    // Strip trailing slash from baseUrl
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokenManager = options.tokenManager;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onAuthExpired = options.onAuthExpired;
    this.retryConfig = options.retry ?? {};

    // Merge user-provided TTLs with defaults
    this.cacheTTLs = { ...DEFAULT_CACHE_TTLS, ...options.cacheTTLs };

    // Initialize cache and rate limiter
    this.cache = new TTLCache();
    const rateLimitConfig = options.rateLimitConfig ?? {
      capacity: 10,
      refillRate: 3,
    };
    this.rateLimiter = new TokenBucket(
      rateLimitConfig.capacity,
      rateLimitConfig.refillRate,
    );

    log("DEBUG", `D2LApiClient initialized for ${this.baseUrl}`);
  }

  /**
   * Initialize the client by discovering API versions.
   * Must be called before making API requests.
   */
  async initialize(): Promise<void> {
    this.versions = await discoverVersions(this.baseUrl, this.timeoutMs);
    log(
      "INFO",
      `D2L API versions discovered: LP ${this.versions.lp}, LE ${this.versions.le}`,
    );
  }

  /**
   * Get discovered API versions.
   * @throws Error if initialize() hasn't been called yet
   */
  get apiVersions(): ApiVersions {
    if (!this.versions) {
      throw new Error(
        "API client not initialized. Call initialize() before accessing apiVersions.",
      );
    }
    return this.versions;
  }

  /**
   * Make a GET request to the D2L API.
   *
   * @param path - API path (e.g., "/d2l/api/lp/1.56/users/whoami")
   * @param options - Request options (ttl for caching)
   * @returns Parsed JSON response (raw, no transformation)
   * @throws ApiError on HTTP errors (401, 403, 429, etc.)
   * @throws NetworkError on network/fetch failures
   */
  async get<T>(path: string, options?: { ttl?: number }): Promise<T> {
    // Check cache first
    if (options?.ttl && this.cache.has(path)) {
      log("DEBUG", `Cache hit: ${path}`);
      return this.cache.get(path) as T;
    }

    // Get authentication token, auto-reauth if expired
    let token = await this.tokenManager.getToken();
    if (!token) {
      token = await this.tryAutoReauth(path);
    }
    const authed = token;

    // Transient failures are retried inside the rate limiter, so every
    // attempt pays for a bucket token and a retry storm cannot bypass it.
    try {
      return await this.retrying(() =>
        this.throttled(() => this.makeRequest<T>(path, authed, options)),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // Final attempt: auto-reauth and retry once
        const freshToken = await this.tryAutoReauth(path);
        return await this.throttled(() => this.makeRequest<T>(path, freshToken, options));
      }
      throw error;
    }
  }

  /**
   * Make a GET request to the D2L API and return raw Response object.
   * Used for binary file downloads where JSON parsing is not desired.
   * Does NOT cache responses (file downloads shouldn't be cached).
   *
   * @param path - API path (e.g., "/d2l/api/le/1.91/123456/content/topics/789/file")
   * @returns Raw Response object for binary data extraction
   * @throws ApiError on HTTP errors (401, 403, 429, etc.)
   * @throws NetworkError on network/fetch failures
   */
  async getRaw(path: string): Promise<Response> {
    // Get authentication token, auto-reauth if expired
    let token = await this.tokenManager.getToken();
    if (!token) {
      token = await this.tryAutoReauth(path);
    }
    const authed = token;

    try {
      return await this.retrying(() =>
        this.throttled(() => this.makeRawRequest(path, authed)),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // Final attempt: auto-reauth and retry once
        const freshToken = await this.tryAutoReauth(path);
        return await this.throttled(() => this.makeRawRequest(path, freshToken));
      }
      throw error;
    }
  }

  /** One rate limiter token per attempt. */
  private async throttled<T>(fn: () => Promise<T>): Promise<T> {
    await this.rateLimiter.consume();
    return fn();
  }

  /** Retry 429, 5xx, and network failures. A 401 is never retried here. */
  private retrying<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      ...this.retryConfig,
      shouldRetry: isRetryableFailure,
      retryAfterMs: retryAfterMsFrom,
    });
  }

  /**
   * Attempt auto-reauthentication via the onAuthExpired callback.
   * If successful, returns the fresh token. Otherwise throws 401 ApiError.
   */
  private async tryAutoReauth(path: string): Promise<TokenData> {
    if (this.onAuthExpired) {
      log("INFO", "Attempting auto-reauthentication...");
      const success = await this.onAuthExpired();
      if (success) {
        const freshToken = await this.tokenManager.getToken();
        if (freshToken) {
          log("INFO", "Auto-reauthentication succeeded, retrying request");
          return freshToken;
        }
      }
      log("WARN", "Auto-reauthentication did not produce a valid token");
    }
    throw new ApiError(401, path, "Session expired. Please re-authenticate via brightspace-auth.");
  }

  /**
   * Internal method to make HTTP request with 401 retry logic.
   */
  private async makeRequest<T>(
    path: string,
    token: TokenData,
    options?: { ttl?: number },
    isRetry: boolean = false,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    try {
      log("DEBUG", `${isRetry ? "Retrying" : "Requesting"} GET ${path}`);

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Handle 401 with retry logic
      if (response.status === 401) {
        if (isRetry) {
          // Second 401 - clear token and throw
          log("DEBUG", "Second 401 response, clearing token");
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // First 401 - try to get fresher token
        log("DEBUG", "First 401 response, attempting retry with fresh token");
        const freshToken = await this.tokenManager.getToken();

        if (!freshToken || freshToken.accessToken === token.accessToken) {
          // No fresher token available
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // Retry with fresh token
        return await this.makeRequest<T>(path, freshToken, options, true);
      }

      // Handle 429 rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
        throw new RateLimitError(path, retryAfterSeconds);
      }

      // Handle 403 (common for past-semester courses)
      if (response.status === 403) {
        const responseText = await response.text();
        throw new ApiError(403, path, responseText);
      }

      // Handle other non-OK responses
      if (!response.ok) {
        const responseText = await response.text();
        throw new ApiError(response.status, path, responseText);
      }

      // Parse and cache response. The body is read as text first because a
      // dead session does not answer 401: it answers HTTP 200 carrying an HTML
      // stub that redirects to /d2l/login?sessionExpired=1. Cookie-authenticated
      // requests take that path, so the marker, not the status, is the signal.
      const responseBody = await response.text();

      let data: T;
      try {
        data = JSON.parse(responseBody) as T;
      } catch {
        // Only now consider the stub: a real payload that merely mentions the
        // marker still parses, so it can never be misread as a dead session.
        if (responseBody.includes(EXPIRED_SESSION_MARKER)) {
          log("DEBUG", "Response carried the session-expired stub, treating it as a 401");
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }
        throw new ApiError(
          response.status,
          path,
          `Expected JSON from ${path} but the body did not parse`,
        );
      }

      if (options?.ttl) {
        this.cache.set(path, data, options.ttl);
        log("DEBUG", `Cached response for ${path} (TTL: ${options.ttl}ms)`);
      }

      return data;
    } catch (error) {
      // Re-throw our own errors
      if (
        error instanceof ApiError ||
        error instanceof RateLimitError ||
        error instanceof NetworkError
      ) {
        throw error;
      }

      // Wrap network/fetch errors
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(
        `Request to ${path} failed: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Internal method to make HTTP request for raw binary data with 401 retry logic.
   */
  private async makeRawRequest(
    path: string,
    token: TokenData,
    isRetry: boolean = false,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    try {
      log("DEBUG", `${isRetry ? "Retrying" : "Requesting"} GET ${path} (raw)`);

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Handle 401 with retry logic
      if (response.status === 401) {
        if (isRetry) {
          // Second 401 - clear token and throw
          log("DEBUG", "Second 401 response, clearing token");
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // First 401 - try to get fresher token
        log("DEBUG", "First 401 response, attempting retry with fresh token");
        const freshToken = await this.tokenManager.getToken();

        if (!freshToken || freshToken.accessToken === token.accessToken) {
          // No fresher token available
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }

        // Retry with fresh token
        return await this.makeRawRequest(path, freshToken, true);
      }

      // Handle 429 rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
        throw new RateLimitError(path, retryAfterSeconds);
      }

      // Handle 403 (common for past-semester courses or no access)
      if (response.status === 403) {
        const responseText = await response.text();
        throw new ApiError(403, path, responseText);
      }

      // Handle 404 (file not found)
      if (response.status === 404) {
        throw new ApiError(404, path, "File not found");
      }

      // Handle other non-OK responses
      if (!response.ok) {
        const responseText = await response.text();
        throw new ApiError(response.status, path, responseText);
      }

      // A dead session answers a file request the same way it answers a
      // JSON one: HTTP 200 carrying an HTML stub that redirects to the
      // login page. Left alone, that stub would be saved to disk under the
      // file's own name. Only HTML is inspected, so real downloads are
      // never buffered here.
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.startsWith("text/html")) {
        const body = await response.text();
        if (body.includes(EXPIRED_SESSION_MARKER)) {
          log("DEBUG", "File download answered with the session-expired stub, treating it as a 401");
          await this.tokenManager.clearToken();
          throw new ApiError(
            401,
            path,
            "Session expired. Please re-authenticate via brightspace-auth.",
          );
        }
        // A legitimate HTML page: hand back an equivalent response with the
        // body we already consumed.
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Return raw response for caller to process
      return response;
    } catch (error) {
      // Re-throw our own errors
      if (
        error instanceof ApiError ||
        error instanceof RateLimitError ||
        error instanceof NetworkError
      ) {
        throw error;
      }

      // Wrap network/fetch errors
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(
        `Request to ${path} failed: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Build authentication headers for a request.
   * Supports both Bearer tokens and cookie-based auth.
   */
  private buildAuthHeaders(token: TokenData): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent":
        "BrightspaceMCP/1.0 (Rohan Muppa; github.com/rohanmuppa/brightspace-mcp-server)",
    };

    // Auto-detect cookie vs Bearer auth based on "cookie:" prefix
    if (token.accessToken.startsWith("cookie:")) {
      // Cookie-based auth: strip prefix and set Cookie header
      headers["Cookie"] = token.accessToken.substring(7);
      log("DEBUG", "Using cookie-based authentication");
    } else {
      // Bearer token auth
      headers["Authorization"] = `Bearer ${token.accessToken}`;
      log("DEBUG", "Using Bearer token authentication");
    }

    return headers;
  }

  /**
   * Build path for LP (Learning Platform) API endpoints.
   * @param path - Path within LP API (e.g., "/users/whoami")
   * @returns Full versioned path (e.g., "/d2l/api/lp/1.56/users/whoami")
   */
  lp(path: string): string {
    const { lp } = this.apiVersions;
    return `/d2l/api/lp/${lp}${path}`;
  }

  /**
   * Build path for LE (Learning Environment) API endpoints with orgUnitId.
   * @param orgUnitId - Organizational unit ID (course ID)
   * @param path - Path within LE API (e.g., "/content/root/")
   * @returns Full versioned path (e.g., "/d2l/api/le/1.91/123456/content/root/")
   */
  le(orgUnitId: number, path: string): string {
    const { le } = this.apiVersions;
    return `/d2l/api/le/${le}/${orgUnitId}${path}`;
  }

  /**
   * Build path for global LE (Learning Environment) API endpoints without orgUnitId.
   * @param path - Path within LE API (e.g., "/enrollments/myenrollments/")
   * @returns Full versioned path (e.g., "/d2l/api/le/1.91/enrollments/myenrollments/")
   */
  leGlobal(path: string): string {
    const { le } = this.apiVersions;
    return `/d2l/api/le/${le}${path}`;
  }

  /**
   * Clear all cached responses.
   */
  clearCache(): void {
    this.cache.clear();
    log("DEBUG", "Cache cleared");
  }

  /**
   * Get current cache size (number of cached entries).
   */
  get cacheSize(): number {
    return this.cache.size;
  }
}
