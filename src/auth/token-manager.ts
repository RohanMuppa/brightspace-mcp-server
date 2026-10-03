/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { TokenData } from "../types/index.js";
import { SessionStore } from "./session-store.js";
import { mintAccessToken } from "./token-mint.js";
import { log } from "../utils/logger.js";
import { TokenRefreshError } from "../api/errors.js";
import { devActivity } from "../utils/dev-activity.js";

/**
 * Token refresh buffer - tokens within this time of expiry are considered invalid.
 * This prevents using tokens that might expire during a request.
 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/** Matches the tokenTtl default in the app config. */
const DEFAULT_TOKEN_TTL_SECONDS = 3600;

export interface TokenManagerOptions {
  sessionDir?: string;
  /** Tenant base URL. Without it the cookie mint is not attempted. */
  baseUrl?: string;
  /** Lifetime in seconds stamped on a minted token. */
  tokenTtl?: number;
  /** Injection seam for tests. */
  mint?: typeof mintAccessToken;
  /** Persistence injection keeps unit tests independent of native credentials. */
  sessionStore?: Pick<SessionStore, "load" | "save" | "clear" | "saveIfCurrent" | "clearIfCurrent">;
  /**
   * Pre-issued Bearer token from D2L_ACCESS_TOKEN. When set, getToken() hands
   * it back directly on every call — no disk, no mint, no browser — and takes
   * precedence over envSessionCookie.
   */
  envAccessToken?: string;
  /**
   * Normalized "d2lSessionVal=...; d2lSecureSessionVal=..." from
   * D2L_SESSION_COOKIE. When set (and envAccessToken is not), getToken()
   * returns it wrapped in the client's existing "cookie:" passthrough auth
   * (see D2LApiClient.buildAuthHeaders) rather than minting a Bearer JWT: the
   * mint endpoint requires a CSRF token that only a live browser page can
   * produce, which a pasted cookie never carries.
   */
  envSessionCookie?: string;
}

/**
 * TokenManager manages token lifecycle with in-memory caching and disk persistence.
 * Handles expiry detection with a configurable refresh buffer.
 */
export class TokenManager {
  private cachedToken: TokenData | null = null;
  private readonly sessionStore: NonNullable<TokenManagerOptions["sessionStore"]>;
  private readonly baseUrl?: string;
  private readonly tokenTtl: number;
  private readonly mint: typeof mintAccessToken;
  private readonly envAccessToken?: string;
  private readonly envSessionCookie?: string;
  /** Single in-flight mint, so concurrent callers share one request. */
  private mintInFlight: Promise<TokenData | null> | null = null;
  private rejectedAccessToken: string | null = null;

  constructor(sessionDir?: string);
  constructor(options: TokenManagerOptions);
  constructor(sessionDirOrOptions?: string | TokenManagerOptions) {
    const options: TokenManagerOptions =
      typeof sessionDirOrOptions === "string" || sessionDirOrOptions === undefined
        ? { sessionDir: sessionDirOrOptions }
        : sessionDirOrOptions;

    this.sessionStore = options.sessionStore ?? new SessionStore(options.sessionDir);
    this.baseUrl = options.baseUrl ? new URL(options.baseUrl).origin : undefined;
    this.tokenTtl = options.tokenTtl ?? DEFAULT_TOKEN_TTL_SECONDS;
    this.mint = options.mint ?? mintAccessToken;
    this.envAccessToken = options.envAccessToken;
    this.envSessionCookie = options.envSessionCookie;
  }

  /**
   * Get the current token if valid, otherwise null.
   * Checks memory cache first, then loads from disk if needed.
   * Returns null if token is expired or within refresh buffer.
   */
  async getToken(rejectedAccessToken?: string): Promise<TokenData | null> {
    if (rejectedAccessToken) this.rejectedAccessToken = rejectedAccessToken;

    // D2L_ACCESS_TOKEN / D2L_SESSION_COOKIE bypass disk, mint, and the browser
    // entirely: every call hands back the same env-derived token. The only
    // way this "expires" is Brightspace rejecting it, which the caller
    // reports back as rejectedAccessToken — at that point there is nothing
    // fresher to offer, so this returns null rather than the same rejected
    // value again. (See D2LApiClient.tryAutoReauth / authExpiredMessage for
    // the user-facing "paste a fresh one" error this produces.)
    if (this.envAccessToken || this.envSessionCookie) {
      const token = this.buildEnvToken();
      if (rejectedAccessToken && token.accessToken === rejectedAccessToken) {
        log("DEBUG", "The env-provided credential was rejected; no replacement is available");
        return null;
      }
      return token;
    }

    // Check memory cache first
    if (this.cachedToken && this.isUsable(this.cachedToken)) {
      log("DEBUG", "Returning cached token");
      return this.cachedToken;
    }

    // Try loading from disk
    const storedToken = await this.sessionStore.load();
    if (storedToken && this.isUsable(storedToken)) {
      log("DEBUG", "Loaded valid token from session store");
      this.cachedToken = storedToken;
      return storedToken;
    }

    // The token is stale, but if it carried the session material we can trade
    // that for a fresh JWT over plain HTTP instead of relaunching the browser.
    // Disk may have been refreshed by another MCP process. Never prefer stale
    // cached cookies over the current persisted session.
    const mintable = this.pickMintable(storedToken);
    if (mintable) {
      const minted = await this.mintFromSession(mintable);
      if (minted) return minted;
    }

    log("DEBUG", "No valid token available");
    return null;
  }

  /**
   * Build the token for D2L_ACCESS_TOKEN or D2L_SESSION_COOKIE;
   * D2L_ACCESS_TOKEN wins when both are set. expiresAt is pushed far into the
   * future: a pasted credential has no known lifetime, and isValid()'s
   * refresh-buffer check must never be the thing that discards it — only
   * Brightspace actually rejecting it (a 401) should.
   */
  private buildEnvToken(): TokenData {
    const now = Date.now();
    const FAR_FUTURE_MS = 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
    if (this.envAccessToken) {
      return {
        accessToken: this.envAccessToken,
        tenantOrigin: this.baseUrl,
        capturedAt: now,
        expiresAt: now + FAR_FUTURE_MS,
        source: "env",
      };
    }
    return {
      // Reuses the client's existing "cookie:" passthrough (see
      // D2LApiClient.buildAuthHeaders) instead of minting a Bearer JWT.
      accessToken: `cookie:${this.envSessionCookie}`,
      tenantOrigin: this.baseUrl,
      capturedAt: now,
      expiresAt: now + FAR_FUTURE_MS,
      source: "env",
      cookieHeader: this.envSessionCookie,
    };
  }

  /**
   * Only use persisted session material, including updates from other processes.
   */
  private pickMintable(candidate: TokenData | null): TokenData | null {
    return this.baseUrl && candidate && this.matchesTenant(candidate) && candidate.cookieHeader && candidate.csrfToken ? candidate : null;
  }

  /**
   * Mint a fresh token from the stale one's session material, collapsing
   * concurrent callers onto a single request.
   */
  private async mintFromSession(stale: TokenData): Promise<TokenData | null> {
    if (this.mintInFlight) {
      log("DEBUG", "Joining the in-flight token mint");
      return this.mintInFlight;
    }

    const inFlight = this.runMint(stale).finally(() => {
      this.mintInFlight = null;
    });
    this.mintInFlight = inFlight;
    return inFlight;
  }

  private async runMint(stale: TokenData): Promise<TokenData | null> {
    const started = Date.now();
    devActivity("token_mint_started");
    log("DEBUG", "Trying to mint an access token from the session cookie");

    let result;
    try {
      result = await this.mint({
        baseUrl: this.baseUrl as string,
        cookieHeader: stale.cookieHeader as string,
        csrfToken: stale.csrfToken as string,
      });
    } catch (error) {
      devActivity("token_mint_finished", { outcome: "transport", elapsedMs: Date.now() - started });
      throw new TokenRefreshError("token service request failed", error instanceof Error ? error : undefined);
    }
    devActivity("token_mint_finished", {
      outcome: result.ok ? "success" : result.reason === "sessionExpired" ? "sessionExpired" : "error",
      elapsedMs: Date.now() - started,
    });

    // The auth CLI or another MCP process can finish a login while HTTP minting
    // is in flight. Its newer session wins over either result of this request.
    const current = await this.sessionStore.load();
    if (current && !this.sameToken(current, stale)) {
      this.cachedToken = current;
      if (this.isUsable(current)) return current;
      throw new TokenRefreshError("saved authentication changed during refresh");
    }

    if (result.ok) {
      const now = Date.now();
      const token: TokenData = {
        accessToken: result.accessToken,
        tenantOrigin: this.baseUrl,
        capturedAt: now,
        expiresAt: now + this.tokenTtl * 1000,
        source: "browser",
        cookieHeader: stale.cookieHeader,
        csrfToken: stale.csrfToken,
        // The cookie mint only returns a JWT, not an identity; carry the
        // uniqueName/displayName the original browser login captured
        // forward so an hourly HTTP re-mint doesn't erase signedInAs.
        uniqueName: stale.uniqueName,
        displayName: stale.displayName,
      };
      if (!await this.sessionStore.saveIfCurrent(token, stale)) return this.afterConcurrentChange();
      this.cachedToken = token;
      this.rejectedAccessToken = null;
      log("INFO", "Minted a fresh access token from the session cookie");
      return token;
    }

    if (result.reason === "sessionExpired") {
      log("INFO", "The session cookie has expired, a browser login is needed");
      if (!await this.sessionStore.clearIfCurrent(stale)) return this.afterConcurrentChange();
      this.cachedToken = null;
      return null;
    }

    throw new TokenRefreshError(result.detail ?? "unexpected token service response");
  }

  /**
   * Set a new token, caching in memory and persisting to disk.
   */
  async setToken(token: TokenData): Promise<void> {
    await this.sessionStore.save(token);
    this.cachedToken = token;
    this.rejectedAccessToken = null;
    log("DEBUG", "Token cached and persisted");
  }

  /**
   * Clear the token from memory and disk.
   */
  async clearToken(): Promise<void> {
    this.cachedToken = null;
    await this.sessionStore.clear();
    log("DEBUG", "Token cleared from memory and disk");
  }

  private isUsable(token: TokenData): boolean {
    return this.matchesTenant(token) && token.accessToken !== this.rejectedAccessToken && this.isValid(token);
  }

  private matchesTenant(token: TokenData): boolean {
    return this.baseUrl === undefined || token.tenantOrigin === this.baseUrl;
  }

  private sameToken(a: TokenData, b: TokenData): boolean {
    return a.accessToken === b.accessToken && a.capturedAt === b.capturedAt &&
      a.cookieHeader === b.cookieHeader && a.csrfToken === b.csrfToken && a.tenantOrigin === b.tenantOrigin;
  }

  private async afterConcurrentChange(): Promise<TokenData | null> {
    this.cachedToken = await this.sessionStore.load();
    if (this.cachedToken && this.isUsable(this.cachedToken)) return this.cachedToken;
    throw new TokenRefreshError("saved authentication changed during refresh");
  }

  /**
   * Check if a token is valid (not expired and outside refresh buffer).
   * A token is valid if it expires more than REFRESH_BUFFER_MS from now.
   */
  isValid(token: TokenData): boolean {
    const now = Date.now();
    const timeUntilExpiry = token.expiresAt - now;

    // Token must expire more than REFRESH_BUFFER_MS in the future
    const valid = timeUntilExpiry > REFRESH_BUFFER_MS;

    if (!valid) {
      log(
        "DEBUG",
        `Token invalid: expires in ${Math.round(timeUntilExpiry / 1000)}s (buffer: ${REFRESH_BUFFER_MS / 1000}s)`
      );
    }

    return valid;
  }

  /**
   * Check if a token refresh is needed.
   * Returns true if no valid token is available.
   */
  async needsRefresh(): Promise<boolean> {
    const token = await this.getToken();
    return token === null;
  }
}
