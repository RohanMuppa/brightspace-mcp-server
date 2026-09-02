/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { TokenData } from "../types/index.js";
import { SessionStore } from "./session-store.js";
import { mintAccessToken } from "./token-mint.js";
import { log } from "../utils/logger.js";

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
}

/**
 * TokenManager manages token lifecycle with in-memory caching and disk persistence.
 * Handles expiry detection with a configurable refresh buffer.
 */
export class TokenManager {
  private cachedToken: TokenData | null = null;
  private readonly sessionStore: SessionStore;
  private readonly baseUrl?: string;
  private readonly tokenTtl: number;
  private readonly mint: typeof mintAccessToken;
  /** Single in-flight mint, so concurrent callers share one request. */
  private mintInFlight: Promise<TokenData | null> | null = null;

  constructor(sessionDir?: string);
  constructor(options: TokenManagerOptions);
  constructor(sessionDirOrOptions?: string | TokenManagerOptions) {
    const options: TokenManagerOptions =
      typeof sessionDirOrOptions === "string" || sessionDirOrOptions === undefined
        ? { sessionDir: sessionDirOrOptions }
        : sessionDirOrOptions;

    this.sessionStore = new SessionStore(options.sessionDir);
    this.baseUrl = options.baseUrl;
    this.tokenTtl = options.tokenTtl ?? DEFAULT_TOKEN_TTL_SECONDS;
    this.mint = options.mint ?? mintAccessToken;
  }

  /**
   * Get the current token if valid, otherwise null.
   * Checks memory cache first, then loads from disk if needed.
   * Returns null if token is expired or within refresh buffer.
   */
  async getToken(): Promise<TokenData | null> {
    // Check memory cache first
    if (this.cachedToken && this.isValid(this.cachedToken)) {
      log("DEBUG", "Returning cached token");
      return this.cachedToken;
    }

    // Try loading from disk
    const storedToken = await this.sessionStore.load();
    if (storedToken && this.isValid(storedToken)) {
      log("DEBUG", "Loaded valid token from session store");
      this.cachedToken = storedToken;
      return storedToken;
    }

    // The token is stale, but if it carried the session material we can trade
    // that for a fresh JWT over plain HTTP instead of relaunching the browser.
    const mintable = this.pickMintable(this.cachedToken, storedToken);
    if (mintable) {
      const minted = await this.mintFromSession(mintable);
      if (minted) return minted;
    }

    log("DEBUG", "No valid token available");
    return null;
  }

  /**
   * First candidate that carries both the cookie header and the XSRF token,
   * or null when neither can be used to mint.
   */
  private pickMintable(
    ...candidates: Array<TokenData | null>
  ): TokenData | null {
    if (!this.baseUrl) return null;
    for (const candidate of candidates) {
      if (candidate?.cookieHeader && candidate.csrfToken) return candidate;
    }
    return null;
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
    log("DEBUG", "Trying to mint an access token from the session cookie");

    const result = await this.mint({
      baseUrl: this.baseUrl as string,
      cookieHeader: stale.cookieHeader as string,
      csrfToken: stale.csrfToken as string,
    });

    if (result.ok) {
      const now = Date.now();
      const token: TokenData = {
        accessToken: result.accessToken,
        capturedAt: now,
        expiresAt: now + this.tokenTtl * 1000,
        source: "browser",
        cookieHeader: stale.cookieHeader,
        csrfToken: stale.csrfToken,
      };
      await this.setToken(token);
      log("INFO", "Minted a fresh access token from the session cookie");
      return token;
    }

    if (result.reason === "sessionExpired") {
      log("INFO", "The session cookie has expired, a browser login is needed");
      await this.clearToken();
      return null;
    }

    log("WARN", `Could not mint an access token: ${result.detail ?? "transport failure"}`);
    return null;
  }

  /**
   * Set a new token, caching in memory and persisting to disk.
   */
  async setToken(token: TokenData): Promise<void> {
    this.cachedToken = token;
    await this.sessionStore.save(token);
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
