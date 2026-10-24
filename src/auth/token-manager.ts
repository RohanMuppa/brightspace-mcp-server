/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { TokenData } from "../types/index.js";
import { SessionStore } from "./session-store.js";
import { mintAccessToken } from "./token-mint.js";
import { fetchXsrfToken } from "./xsrf-fetch.js";
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

/** How long a D2L_SESSION_COOKIE mint that failed in transit waits before trying again. */
const ENV_MINT_RETRY_MS = 60 * 1000;

export interface TokenManagerOptions {
  sessionDir?: string;
  /** Tenant base URL. Without it the cookie mint is not attempted. */
  baseUrl?: string;
  /** Lifetime in seconds stamped on a minted token. */
  tokenTtl?: number;
  /** Injection seam for tests. */
  mint?: typeof mintAccessToken;
  /** Injection seam for tests. */
  fetchXsrf?: typeof fetchXsrfToken;
  /** Persistence injection keeps unit tests independent of native credentials. */
  sessionStore?: Pick<SessionStore, "load" | "save" | "clear" | "saveIfCurrent" | "clearIfCurrent"> & Partial<Pick<SessionStore, "fingerprint">>;
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
   * (see D2LApiClient.buildAuthHeaders), unless mintEnvCookie trades it for a
   * Bearer JWT first.
   */
  envSessionCookie?: string;
  /**
   * Trade envSessionCookie for a Bearer JWT over plain HTTP: read the XSRF
   * token off /d2l/home with the cookie, then call the token mint. The JWT is
   * held in memory only and re-minted when it expires. Any failure falls back
   * to the cookie passthrough. Needs baseUrl. Off by default so read-only
   * callers (doctor, setup --prepare) make no extra requests.
   */
  mintEnvCookie?: boolean;
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
  private readonly fetchXsrf: typeof fetchXsrfToken;
  private readonly envAccessToken?: string;
  private readonly envSessionCookie?: string;
  private readonly mintEnvCookie: boolean;
  /** The Bearer JWT minted from envSessionCookie, memory only. */
  private envMinted: TokenData | null = null;
  /** The XSRF token that last minted successfully, reused for the hourly re-mint. */
  private envCsrfToken: string | undefined;
  /** Set once the env cookie is known not to mint, so later calls skip straight to the passthrough. */
  private envMintDisabled = false;
  private envMintRetryAt = 0;
  private envMintInFlight: Promise<TokenData | null> | null = null;
  /** Single in-flight mint, so concurrent callers share one request. */
  private mintInFlight: Promise<TokenData | null> | null = null;
  private rejectedAccessToken: string | null = null;
  /**
   * The saved session this process last read or wrote, as the account it
   * belongs to. Kept even while cachedToken is null (an unusable token on
   * disk), so a later sign-in can still be compared with the account that
   * the in-memory state, and the API client's response cache, were built for.
   * Null once the session is known to be gone.
   */
  private identityToken: TokenData | null = null;
  /** SessionStore.fingerprint() of the file when identityToken was read or written. */
  private observedFingerprint: string | undefined;
  /**
   * Set when the session was signed out or replaced by a different account
   * since sessionChanged() last answered. Errs toward true.
   */
  private sessionReplaced = false;

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
    this.fetchXsrf = options.fetchXsrf ?? fetchXsrfToken;
    this.envAccessToken = options.envAccessToken;
    this.envSessionCookie = options.envSessionCookie;
    this.mintEnvCookie = options.mintEnvCookie ?? false;
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
      if (!this.envAccessToken && this.mintEnvCookie && this.baseUrl) {
        const minted = await this.envCookieBearer(rejectedAccessToken);
        if (minted) return minted;
      }
      const token = this.buildEnvToken();
      if (rejectedAccessToken && token.accessToken === rejectedAccessToken) {
        log("DEBUG", "The env-provided credential was rejected; no replacement is available");
        return null;
      }
      return token;
    }

    // Check memory cache first, after asking whether the saved session is
    // still the one this process remembers. Another process may have signed
    // out (deleted it), or signed in again, since this token was cached; when
    // it has, the memory is dropped or refreshed from disk here. Skipped when
    // nothing is remembered, so a cold start costs no extra stat.
    await this.syncWithDisk();
    if (this.cachedToken && this.isUsable(this.cachedToken)) {
      log("DEBUG", "Returning cached token");
      return this.cachedToken;
    }

    // Try loading from disk
    const storedToken = await this.sessionStore.load();
    if (storedToken) await this.observe(storedToken);
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
   * Whether the saved session was signed out or replaced by a different
   * account since this was last asked, for example by `brightspace-auth
   * --logout` or the sign_out tool running in another process, or a new
   * sign-in as someone else. When it was, anything built under the old
   * session (the API client's response cache) must not be trusted. Costs one
   * stat while the file is unchanged.
   *
   * True when the file is missing, and when a reload shows a different
   * account than the one remembered. Names are compared when both sides have
   * one, otherwise the session cookie; with neither, the answer is true,
   * because when unsure the safe move is to clear. The same account's token
   * re-minted by another process (hourly) is not a change, so it does not
   * wipe a cache that is still valid. The answer is true once per change.
   * Always false for D2L_ACCESS_TOKEN / D2L_SESSION_COOKIE, which have no
   * saved session. A failed stat answers false; a replaced file this process
   * cannot read answers true (the in-memory token is still served, but cached
   * responses are not trusted until the file reads again).
   */
  async sessionChanged(): Promise<boolean> {
    if (this.envAccessToken || this.envSessionCookie) return false;
    await this.syncWithDisk();
    const changed = this.sessionReplaced;
    this.sessionReplaced = false;
    return changed;
  }

  /**
   * Drop everything remembered about the saved session without touching any
   * file: the cached token, a remembered rejection and the recorded file
   * identity. The next getToken() reads the disk afresh. Call it right after
   * deleting the session files (the sign_out tool does), so this process stops
   * acting signed in even when another app has already signed in again and
   * recreated the file, which a plain existence check could not tell apart.
   * Also makes the next sessionChanged() answer true, so cached API responses
   * are not served either.
   */
  forgetSession(): void {
    this.cachedToken = null;
    this.rejectedAccessToken = null;
    this.identityToken = null;
    this.observedFingerprint = undefined;
    this.sessionReplaced = true;
  }

  /**
   * Compare the saved file with what this process last saw of it, and bring
   * memory in line: file gone, forget everything; file replaced or rewritten,
   * reload it and adopt it (flagging a different account). A fingerprint
   * that cannot be determined, or an unreadable replacement, keeps the
   * current state, with an unreadable replacement flagged as changed.
   * Does nothing, and costs nothing, when nothing is remembered.
   */
  private async syncWithDisk(): Promise<void> {
    if (!this.identityToken && !this.rejectedAccessToken) return;
    const fingerprint = await this.sessionStore.fingerprint?.();
    if (fingerprint === null) {
      log("DEBUG", "The saved session is gone; dropping the in-memory token");
      this.forgetSession();
      return;
    }
    if (typeof fingerprint !== "string" || !this.identityToken || fingerprint === this.observedFingerprint) return;

    log("DEBUG", "The saved session changed on disk; reloading it");
    let loaded: TokenData | null;
    try {
      loaded = await this.sessionStore.load();
    } catch (error) {
      // Cannot tell whose session this is. Keep serving the token in memory,
      // do not record the fingerprint (so the next call tries again), and
      // make sure cached responses are not trusted.
      log("WARN", "The saved session changed but could not be read", error);
      this.sessionReplaced = true;
      return;
    }
    if (!loaded) {
      this.forgetSession();
      return;
    }
    this.adopt(loaded, fingerprint);
    this.cachedToken = this.isUsable(loaded) ? loaded : null;
  }

  /**
   * Remember `token` as the session now on disk. `fingerprint` is the file's
   * identity from a stat taken before it was read; without one, it is taken
   * now, after the read or write that produced `token`. If another process
   * rewrote the file in the instant between that read or write and the stat,
   * this records their file's identity against our token, so the change goes
   * unnoticed until the next rewrite. That is acceptable: the token held is
   * itself valid, and the window is microseconds wide.
   */
  private adopt(token: TokenData, fingerprint: string | null | undefined): void {
    if (this.identityToken && !this.sameAccount(this.identityToken, token)) this.sessionReplaced = true;
    this.identityToken = token;
    this.observedFingerprint = fingerprint ?? undefined;
  }

  private async observe(token: TokenData): Promise<void> {
    this.adopt(token, await this.sessionStore.fingerprint?.());
  }

  /**
   * Whether two sessions belong to the same account on the same tenant.
   * Unknown is not the same: with no name on both sides and no shared cookie,
   * this answers false.
   */
  private sameAccount(a: TokenData, b: TokenData): boolean {
    if (a.tenantOrigin !== b.tenantOrigin) return false;
    if (a.uniqueName !== undefined && b.uniqueName !== undefined) {
      return a.uniqueName.toLowerCase() === b.uniqueName.toLowerCase();
    }
    return a.cookieHeader !== undefined && a.cookieHeader === b.cookieHeader;
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
   * The Bearer JWT minted from envSessionCookie, minting one when there is
   * none or it expired or was just rejected. Null means use the cookie
   * passthrough instead, which also keeps the existing "paste a fresh one"
   * error for a dead cookie.
   */
  private async envCookieBearer(rejectedAccessToken?: string): Promise<TokenData | null> {
    if (this.envMinted && rejectedAccessToken === this.envMinted.accessToken) {
      log("DEBUG", "The JWT minted from D2L_SESSION_COOKIE was rejected; minting again");
      this.envMinted = null;
    }
    if (this.envMinted && this.isValid(this.envMinted)) return this.envMinted;
    if (this.envMintDisabled || Date.now() < this.envMintRetryAt) return null;
    this.envMintInFlight ??= this.runEnvMint().finally(() => {
      this.envMintInFlight = null;
    });
    return this.envMintInFlight;
  }

  private async runEnvMint(): Promise<TokenData | null> {
    const baseUrl = this.baseUrl as string;
    const cookieHeader = this.envSessionCookie as string;

    let csrfToken = this.envCsrfToken;
    if (!csrfToken) {
      const xsrf = await this.fetchXsrf({ baseUrl, cookieHeader });
      if (!xsrf.ok) return this.envMintFailed(xsrf.reason, xsrf.detail);
      csrfToken = xsrf.csrfToken;
    }

    let result;
    try {
      result = await this.mint({ baseUrl, cookieHeader, csrfToken });
    } catch (error) {
      return this.envMintFailed("transport", error instanceof Error ? error.message : String(error));
    }
    if (!result.ok) {
      // A stale XSRF token is one cause of a refused mint; read a fresh one next time.
      this.envCsrfToken = undefined;
      return this.envMintFailed(result.reason, result.detail);
    }

    const now = Date.now();
    this.envCsrfToken = csrfToken;
    this.envMinted = {
      accessToken: result.accessToken,
      tenantOrigin: this.baseUrl,
      capturedAt: now,
      expiresAt: now + this.tokenTtl * 1000,
      source: "env",
      cookieHeader,
    };
    log("INFO", "Minted a Bearer token from D2L_SESSION_COOKIE without a browser");
    return this.envMinted;
  }

  /**
   * A dead cookie or a page with no XSRF token will not mint later either, so
   * stop trying; a transport failure is retried after ENV_MINT_RETRY_MS.
   */
  private envMintFailed(reason: "sessionExpired" | "notFound" | "transport", detail?: string): null {
    if (reason === "transport") {
      this.envMintRetryAt = Date.now() + ENV_MINT_RETRY_MS;
    } else {
      this.envMintDisabled = true;
    }
    log("DEBUG", `Could not mint from D2L_SESSION_COOKIE (${reason}${detail ? `: ${detail}` : ""}); using the cookie as-is`);
    return null;
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
    if (!current) {
      // Signed out while the mint was in flight. Saving a token now would
      // quietly undo that, so drop everything and let the caller sign in.
      log("DEBUG", "The saved session was removed during the refresh");
      this.forgetSession();
      return null;
    }
    if (!this.sameToken(current, stale)) {
      await this.observe(current);
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
      await this.observe(token);
      this.cachedToken = token;
      this.rejectedAccessToken = null;
      log("INFO", "Minted a fresh access token from the session cookie");
      return token;
    }

    if (result.reason === "sessionExpired") {
      log("INFO", "The session cookie has expired, a browser login is needed");
      if (!await this.sessionStore.clearIfCurrent(stale)) return this.afterConcurrentChange();
      this.cachedToken = null;
      this.observedFingerprint = undefined;
      return null;
    }

    throw new TokenRefreshError(result.detail ?? "unexpected token service response");
  }

  /**
   * Set a new token, caching in memory and persisting to disk.
   */
  async setToken(token: TokenData): Promise<void> {
    await this.sessionStore.save(token);
    await this.observe(token);
    this.cachedToken = token;
    this.rejectedAccessToken = null;
    log("DEBUG", "Token cached and persisted");
  }

  /**
   * Clear the token from memory and disk.
   */
  async clearToken(): Promise<void> {
    this.cachedToken = null;
    this.identityToken = null;
    this.observedFingerprint = undefined;
    this.sessionReplaced = true;
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
    const loaded = await this.sessionStore.load();
    if (!loaded) {
      // Nothing is saved any more: the user signed out. That is not a refresh
      // failure; the caller proceeds to the ordinary sign-in.
      this.forgetSession();
      return null;
    }
    await this.observe(loaded);
    this.cachedToken = loaded;
    if (this.isUsable(loaded)) return loaded;
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
