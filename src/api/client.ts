/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { D2LApiClientOptions, ApiVersions, CacheTTLs, TokenData, ClientStats } from "./types.js";
import { DEFAULT_CACHE_TTLS } from "./types.js";
import { TTLCache } from "./cache.js";
import { TokenBucket } from "./rate-limiter.js";
import { discoverVersions } from "./version-discovery.js";
import { ApiError, RateLimitError, NetworkError } from "./errors.js";
import {
  withRetry,
  isRetryableFailure,
  retryAfterMsFrom,
  parseRetryAfter,
  type RetryConfig,
} from "./retry.js";
import { log } from "../utils/logger.js";
import { AUTH_COMMAND } from "../utils/commands.js";
import { devActivity } from "../utils/dev-activity.js";

/** An ordinary course HTML link to the login page is not an expired session. */
function isExpiredSessionRedirect(body: string, baseUrl: string): boolean {
  const expiredTarget = (target: string): boolean => {
    try {
      const url = new URL(target.replace(/&amp;/gi, "&").replace(/\\\//g, "/"), baseUrl);
      return url.origin === new URL(baseUrl).origin && url.pathname === "/d2l/login" &&
        url.searchParams.get("sessionExpired") === "1";
    } catch {
      return false;
    }
  };
  for (const script of body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const redirect = /(?:(?:window|document)\s*\.\s*)?location\s*(?:\.\s*(?:replace|assign)\s*\(\s*|(?:\.\s*href\s*)?=\s*)(["'])(.*?)\1/g;
    for (const match of script[1].matchAll(redirect)) {
      if (expiredTarget(match[2])) return true;
    }
  }
  for (const meta of body.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map(
      [...meta[0].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1].toLowerCase(), match[3]]),
    );
    if (attributes.get("http-equiv")?.toLowerCase() !== "refresh") continue;
    const target = attributes.get("content")?.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.*?)\s*$/i)?.[1];
    if (target && expiredTarget(target)) return true;
  }
  return false;
}

/**
 * Stand-ins for the discovered LP and LE versions.
 *
 * lp(), le(), and leGlobal() are synchronous path builders called from about
 * forty places across the tools, but the versions they need come from a
 * network request. Emitting a placeholder and substituting it inside get()
 * and getRaw() keeps that request off the startup path without turning every
 * one of those call sites async, and it means a newly added tool cannot
 * forget to wait for discovery: the path it builds carries the requirement.
 *
 * Braces are used because D2L paths never contain them, so a substitution can
 * never collide with a real path segment.
 */
const LP_VERSION = "{lp}";
const LE_VERSION = "{le}";

/**
 * D2L API client with authentication, caching, rate limiting, and version discovery.
 *
 * Key features:
 * - Auto-discovers LP/LE versions from /d2l/api/versions/ on the first request
 * - Supports both Bearer tokens and cookie-based auth (auto-detected via "cookie:" prefix)
 * - Client-side rate limiting using token bucket algorithm
 * - In-memory response caching with per-data-type TTLs
 * - 401 recovery: refresh the token before requesting browser authentication
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
  private readonly authExpiredMessage?: string;
  private readonly retryConfig: RetryConfig;
  private versions: ApiVersions | null = null;
  /** Single in-flight discovery, so concurrent first requests share one fetch. */
  private versionsInFlight: Promise<ApiVersions> | null = null;
  /**
   * GETs keyed by the unresolved template path + query (the same string
   * get() caches under), so a second caller asking for the same resource
   * while the first is still in flight joins that promise instead of
   * issuing its own request. Claude Desktop fans out tool calls in
   * parallel and our tools fan out per course, so identical paths are
   * often requested within milliseconds of each other. One client, one
   * token manager, so every GET it issues already shares one auth
   * identity — nothing further to key on.
   *
   * Adapted from JhostinAleck/brightspace-mcp (MIT) — RequestCoalescer.ts.
   */
  private readonly pendingGets = new Map<string, Promise<unknown>>();
  private readonly statsData: ClientStats = {
    statusClasses: { "2xx": 0, "401": 0, "403": 0, "404": 0, "429": 0, "5xx": 0, other: 0 },
    networkErrors: 0,
    cacheHits: 0,
    cacheMisses: 0,
    coalescedJoins: 0,
    tokenRefreshes: 0,
  };

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
    this.authExpiredMessage = options.authExpiredMessage;
    this.retryConfig = options.retry ?? {};

    // Merge user-provided TTLs with defaults
    this.cacheTTLs = { ...DEFAULT_CACHE_TTLS, ...options.cacheTTLs };

    // Initialize cache and rate limiter
    this.cache = new TTLCache();
    // Sized for the per-course fan-out the tools do (a dozen courses is ~60
    // requests); at 3/s that took ~17 s once the limiter actually reserved
    // tokens. Brightspace 429s are still retried with Retry-After.
    const rateLimitConfig = options.rateLimitConfig ?? {
      capacity: 20,
      refillRate: 8,
    };
    this.rateLimiter = new TokenBucket(
      rateLimitConfig.capacity,
      rateLimitConfig.refillRate,
    );

    log("DEBUG", `D2LApiClient initialized for ${this.baseUrl}`);
  }

  /**
   * Discover the API versions, joining a discovery already in flight.
   *
   * Called from get() and getRaw() rather than at startup, so the server
   * answers tools/list without touching the network and a user who never
   * calls a tool never pays for a request. Nothing needs to call this
   * directly.
   */
  async ensureVersions(): Promise<ApiVersions> {
    if (this.versions) return this.versions;

    if (!this.versionsInFlight) {
      // The latch is released by the flow that owns it, as it settles, so a
      // failed discovery is never replayed: the request after a network blip
      // starts a fresh fetch instead of inheriting the stale rejection.
      const flow = discoverVersions(this.baseUrl, this.timeoutMs)
        .then(versions => {
          this.versions = versions;
          log("INFO", `D2L API versions discovered: LP ${versions.lp}, LE ${versions.le}`);
          return versions;
        })
        .finally(() => {
          if (this.versionsInFlight === flow) this.versionsInFlight = null;
        });
      this.versionsInFlight = flow;
    }

    return this.versionsInFlight;
  }

  /**
   * Discover API versions eagerly. Idempotent, and no longer required:
   * requests discover on demand. Kept for callers that want the network
   * failure up front rather than on the first tool call.
   */
  async initialize(): Promise<void> {
    await this.ensureVersions();
  }

  /**
   * Get discovered API versions.
   * @throws Error if no request has discovered them yet
   */
  get apiVersions(): ApiVersions {
    if (!this.versions) {
      throw new Error(
        "API versions have not been discovered yet. They are fetched on the first request.",
      );
    }
    return this.versions;
  }

  /**
   * Substitute the discovered versions into a path built by lp(), le(), or
   * leGlobal(), discovering them first if no request has yet.
   *
   * A path that carries no placeholder is returned untouched and costs
   * nothing: a bookmark page whose URL came back fully resolved from D2L
   * does not trigger a discovery of its own.
   */
  private async resolvePath(path: string): Promise<string> {
    if (!path.includes(LP_VERSION) && !path.includes(LE_VERSION)) return path;
    const { lp, le } = await this.ensureVersions();
    return path.split(LP_VERSION).join(lp).split(LE_VERSION).join(le);
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
    // Checked before the path is resolved, and keyed by the path as the caller
    // wrote it, so a cached read needs neither version discovery nor a token.
    //
    // The entry has to be younger than this caller's own TTL, not merely
    // still alive. One path can be written under two TTLs: the discussion
    // forum list is thirty minutes of course content to get_discussions and
    // ten minutes of due dates to get_upcoming_due_dates. Trusting the
    // surviving entry served the longer caller's staleness to the shorter one.
    if (options?.ttl) {
      const age = this.cache.ageOf(path);
      if (age !== undefined && age <= options.ttl) {
        log("DEBUG", `Cache hit: ${path}`);
        this.statsData.cacheHits++;
        return this.cache.get(path) as T;
      }
      this.statsData.cacheMisses++;
    }

    // Join an identical GET already in flight rather than issuing a second
    // one. Keyed on the same unresolved path the cache above uses, so the
    // join happens before version discovery or a token is even touched.
    const pending = this.pendingGets.get(path) as Promise<T> | undefined;
    if (pending) {
      this.statsData.coalescedJoins++;
      log("DEBUG", `Coalescing GET onto an in-flight request: ${path}`);
      return pending;
    }

    const inFlight = (async (): Promise<T> => {
      const resolved = await this.resolvePath(path);
      const data = await this.withAuthentication(resolved, token => this.makeRequest<T>(resolved, token));

      if (options?.ttl) {
        this.cache.set(path, data, options.ttl);
        log("DEBUG", `Cached response for ${path} (TTL: ${options.ttl}ms)`);
      }

      return data;
    })().finally(() => {
      if (this.pendingGets.get(path) === inFlight) this.pendingGets.delete(path);
    });
    this.pendingGets.set(path, inFlight);
    return inFlight;
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
    const resolved = await this.resolvePath(path);
    return this.withAuthentication(resolved, token => this.makeRawRequest(resolved, token));
  }

  /** One HTTP refresh and at most one browser login per caller. */
  private async withAuthentication<T>(path: string, request: (token: TokenData) => Promise<T>): Promise<T> {
    let token = await this.tokenManager.getToken();
    let authenticated = false;
    if (!token) {
      token = await this.tryAutoReauth(path);
      authenticated = true;
    }
    const send = (current: TokenData) => this.retrying(() => this.throttled(() => request(current)));
    try {
      return await send(token);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      if (authenticated) throw error;
    }

    // A rejected JWT does not prove its underlying cookie is expired. Read a
    // token written by another process or mint over HTTP before opening login.
    // TokenRefreshError propagates here, so a temporary outage never starts MFA.
    // One 401-recovery cascade counts as one refresh even when it takes both a
    // mint attempt and a browser login to land a token the server accepts --
    // `refreshed` tracks whether this cascade has already been counted so the
    // fallback to tryAutoReauth below doesn't count it a second time.
    const fresh = await this.tokenManager.getToken(token.accessToken);
    let refreshed = false;
    if (fresh && fresh.accessToken !== token.accessToken) {
      this.statsData.tokenRefreshes++;
      refreshed = true;
      try {
        return await send(fresh);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
      }
    }

    const loggedIn = await this.tryAutoReauth(path, fresh?.accessToken ?? token.accessToken);
    if (!refreshed) this.statsData.tokenRefreshes++;
    return send(loggedIn);
  }

  /** Buckets one observed HTTP status into statsData.statusClasses. */
  private recordStatus(status: number): void {
    devActivity("http_response", { status });
    const classes = this.statsData.statusClasses;
    if (status >= 200 && status < 300) classes["2xx"]++;
    else if (status === 401) classes["401"]++;
    else if (status === 403) classes["403"]++;
    else if (status === 404) classes["404"]++;
    else if (status === 429) classes["429"]++;
    else if (status >= 500) classes["5xx"]++;
    else classes.other++;
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
  private async tryAutoReauth(path: string, rejectedAccessToken?: string): Promise<TokenData> {
    devActivity("auth_required");
    if (this.onAuthExpired) {
      log("INFO", "Attempting auto-reauthentication...");
      const success = await this.onAuthExpired();
      if (success) {
        const freshToken = await this.tokenManager.getToken(rejectedAccessToken);
        if (freshToken) {
          log("INFO", "Auto-reauthentication succeeded, retrying request");
          return freshToken;
        }
      }
      log("WARN", "Auto-reauthentication did not produce a valid token");
    }
    throw new ApiError(401, path, this.authExpiredMessage ?? `Session expired. Please re-authenticate via ${AUTH_COMMAND}.`);
  }

  /**
   * Make one HTTP request. Authentication recovery is shared with raw downloads.
   */
  private async makeRequest<T>(
    path: string,
    token: TokenData,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    try {
      log("DEBUG", `Requesting GET ${path}`);

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      this.recordStatus(response.status);

      // Preserve cookie material: a 401 only rejects this access token.
      if (response.status === 401) {
        throw new ApiError(401, path, "Brightspace rejected the access token.");
      }

      // Handle 429 rate limiting
      if (response.status === 429) {
        throw new RateLimitError(path, parseRetryAfter(response.headers.get("Retry-After")));
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
        if (isExpiredSessionRedirect(responseBody, this.baseUrl)) {
          log("DEBUG", "Response carried the session-expired stub, treating it as a 401");
          throw new ApiError(
            401,
            path,
            `Session expired. Please re-authenticate via ${AUTH_COMMAND}.`,
          );
        }
        throw new ApiError(
          response.status,
          path,
          `Expected JSON from ${path} but the body did not parse`,
        );
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
      this.statsData.networkErrors++;
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(
        `Request to ${path} failed: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Make one HTTP request for raw binary data.
   */
  private async makeRawRequest(
    path: string,
    token: TokenData,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    try {
      log("DEBUG", `Requesting GET ${path} (raw)`);

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      this.recordStatus(response.status);

      // Preserve cookie material for the shared HTTP refresh path.
      if (response.status === 401) {
        throw new ApiError(401, path, "Brightspace rejected the access token.");
      }

      // Handle 429 rate limiting
      if (response.status === 429) {
        throw new RateLimitError(path, parseRetryAfter(response.headers.get("Retry-After")));
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
        if (isExpiredSessionRedirect(body, this.baseUrl)) {
          log("DEBUG", "File download answered with the session-expired stub, treating it as a 401");
          throw new ApiError(
            401,
            path,
            `Session expired. Please re-authenticate via ${AUTH_COMMAND}.`,
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
      this.statsData.networkErrors++;
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
   *
   * The version is left as a placeholder and substituted by get() or getRaw()
   * once it has been discovered. See LP_VERSION above.
   *
   * @param path - Path within LP API (e.g., "/users/whoami")
   * @returns Versioned path template (e.g., "/d2l/api/lp/{lp}/users/whoami")
   */
  lp(path: string): string {
    return `/d2l/api/lp/${LP_VERSION}${path}`;
  }

  /**
   * Build path for LE (Learning Environment) API endpoints with orgUnitId.
   * @param orgUnitId - Organizational unit ID (course ID)
   * @param path - Path within LE API (e.g., "/content/root/")
   * @returns Versioned path template (e.g., "/d2l/api/le/{le}/123456/content/root/")
   */
  le(orgUnitId: number, path: string): string {
    return `/d2l/api/le/${LE_VERSION}/${orgUnitId}${path}`;
  }

  /**
   * Build path for global LE (Learning Environment) API endpoints without orgUnitId.
   * @param path - Path within LE API (e.g., "/enrollments/myenrollments/")
   * @returns Versioned path template (e.g., "/d2l/api/le/{le}/enrollments/myenrollments/")
   */
  leGlobal(path: string): string {
    return `/d2l/api/le/${LE_VERSION}${path}`;
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

  /**
   * Read-only snapshot of this client's lightweight request counters. A
   * fresh object every call, so a caller holding onto it never sees later
   * updates and can't mutate the client's own counts. Never carries a URL,
   * username, or token.
   */
  stats(): ClientStats {
    return {
      statusClasses: { ...this.statsData.statusClasses },
      networkErrors: this.statsData.networkErrors,
      cacheHits: this.statsData.cacheHits,
      cacheMisses: this.statsData.cacheMisses,
      coalescedJoins: this.statsData.coalescedJoins,
      tokenRefreshes: this.statsData.tokenRefreshes,
    };
  }
}
