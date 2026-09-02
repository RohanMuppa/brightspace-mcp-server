import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TokenManager } from "../../src/auth/token-manager.js";
import { SessionStore } from "../../src/auth/session-store.js";
import type { TokenData } from "../../src/types/index.js";
import type { mintAccessToken } from "../../src/auth/token-mint.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

type MintFn = typeof mintAccessToken;

describe("TokenManager", () => {
  let testDir: string;
  let tokenManager: TokenManager;

  beforeEach(async () => {
    // Create isolated temp directory for each test
    testDir = path.join(
      os.tmpdir(),
      `token-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    tokenManager = new TokenManager(testDir);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getToken", () => {
    it("returns null when no token cached and no session file", async () => {
      const token = await tokenManager.getToken();
      expect(token).toBeNull();
    });

    it("returns null for expired token", async () => {
      // Create token that expired 1 hour ago
      const expiredToken: TokenData = {
        accessToken: "expired-token",
        capturedAt: Date.now() - 7200000, // 2 hours ago
        expiresAt: Date.now() - 3600000, // 1 hour ago
        source: "browser",
      };

      await tokenManager.setToken(expiredToken);
      const retrieved = await tokenManager.getToken();

      expect(retrieved).toBeNull();
    });

    it("returns null for token expiring within refresh buffer", async () => {
      // Create token that expires in 4 minutes (buffer is 5 minutes)
      const soonToExpireToken: TokenData = {
        accessToken: "soon-to-expire",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 4 * 60 * 1000, // 4 minutes from now
        source: "browser",
      };

      await tokenManager.setToken(soonToExpireToken);
      const retrieved = await tokenManager.getToken();

      expect(retrieved).toBeNull();
    });

    it("loads from session store if not in memory", async () => {
      // Create valid token that expires in 10 minutes
      const validToken: TokenData = {
        accessToken: "stored-token",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
        source: "browser",
      };

      // Save directly via session store (bypassing memory cache)
      const sessionStore = new SessionStore(testDir);
      await sessionStore.save(validToken);

      // Create new TokenManager instance (fresh memory)
      const newTokenManager = new TokenManager(testDir);
      const retrieved = await newTokenManager.getToken();

      expect(retrieved).toEqual(validToken);
    });
  });

  describe("setToken", () => {
    it("caches token in memory", async () => {
      const token: TokenData = {
        accessToken: "cached-token",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000, // 1 hour
        source: "browser",
      };

      await tokenManager.setToken(token);
      const retrieved = await tokenManager.getToken();

      expect(retrieved).toEqual(token);
    });

    it("persists token to session store", async () => {
      const token: TokenData = {
        accessToken: "persisted-token",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000, // 1 hour
        source: "browser",
      };

      await tokenManager.setToken(token);

      // Create new TokenManager with same session dir (fresh memory)
      const newTokenManager = new TokenManager(testDir);
      const retrieved = await newTokenManager.getToken();

      expect(retrieved).toEqual(token);
    });
  });

  describe("isValid", () => {
    it("returns false for expired tokens", () => {
      const expiredToken: TokenData = {
        accessToken: "expired",
        capturedAt: Date.now() - 7200000,
        expiresAt: Date.now() - 3600000, // Expired 1 hour ago
        source: "browser",
      };

      expect(tokenManager.isValid(expiredToken)).toBe(false);
    });

    it("returns false for tokens expiring within buffer", () => {
      const soonExpiredToken: TokenData = {
        accessToken: "soon-expired",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 4 * 60 * 1000, // 4 minutes (< 5 min buffer)
        source: "browser",
      };

      expect(tokenManager.isValid(soonExpiredToken)).toBe(false);
    });

    it("returns true for tokens with sufficient time", () => {
      const validToken: TokenData = {
        accessToken: "valid",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
        source: "browser",
      };

      expect(tokenManager.isValid(validToken)).toBe(true);
    });
  });

  describe("clearToken", () => {
    it("removes from memory and disk", async () => {
      const token: TokenData = {
        accessToken: "to-be-cleared",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        source: "browser",
      };

      await tokenManager.setToken(token);

      // Verify it's there
      let retrieved = await tokenManager.getToken();
      expect(retrieved).toEqual(token);

      // Clear
      await tokenManager.clearToken();

      // Verify it's gone
      retrieved = await tokenManager.getToken();
      expect(retrieved).toBeNull();

      // Verify it's also gone from disk (new manager instance)
      const newTokenManager = new TokenManager(testDir);
      retrieved = await newTokenManager.getToken();
      expect(retrieved).toBeNull();
    });
  });

  describe("needsRefresh", () => {
    it("returns true when no valid token available", async () => {
      const needsRefresh = await tokenManager.needsRefresh();
      expect(needsRefresh).toBe(true);
    });

    it("returns true when token is expired", async () => {
      const expiredToken: TokenData = {
        accessToken: "expired",
        capturedAt: Date.now() - 7200000,
        expiresAt: Date.now() - 3600000,
        source: "browser",
      };

      await tokenManager.setToken(expiredToken);
      const needsRefresh = await tokenManager.needsRefresh();

      expect(needsRefresh).toBe(true);
    });

    it("returns false when valid token exists", async () => {
      const validToken: TokenData = {
        accessToken: "valid",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000,
        source: "browser",
      };

      await tokenManager.setToken(validToken);
      const needsRefresh = await tokenManager.needsRefresh();

      expect(needsRefresh).toBe(false);
    });
  });

  describe("minting from the session cookie", () => {
    const BASE_URL = "https://purdue.brightspace.com";
    const TOKEN_TTL = 3600;

    /** An expired token that still carries the material needed to mint. */
    const expiredWithCookies = (): TokenData => ({
      accessToken: "stale-jwt",
      capturedAt: Date.now() - 7200000,
      expiresAt: Date.now() - 3600000,
      source: "browser",
      cookieHeader: "d2lSessionVal=aaa; d2lSecureSessionVal=bbb",
      csrfToken: "xsrf-123",
    });

    const makeManager = (mint: MintFn) =>
      new TokenManager({
        sessionDir: testDir,
        baseUrl: BASE_URL,
        tokenTtl: TOKEN_TTL,
        mint,
      });

    it("mints a fresh token when the stored one expired", async () => {
      const stale = expiredWithCookies();
      const mint = vi.fn(async () => ({ ok: true, accessToken: "fresh-jwt" }) as const);
      const manager = makeManager(mint);
      await manager.setToken(stale);

      const before = Date.now();
      const retrieved = await manager.getToken();

      expect(mint).toHaveBeenCalledTimes(1);
      expect(mint.mock.calls[0][0]).toMatchObject({
        baseUrl: BASE_URL,
        cookieHeader: stale.cookieHeader,
        csrfToken: stale.csrfToken,
      });
      expect(retrieved?.accessToken).toBe("fresh-jwt");
      expect(retrieved?.expiresAt).toBeGreaterThanOrEqual(before + TOKEN_TTL * 1000);
      expect(retrieved?.cookieHeader).toBe(stale.cookieHeader);
      expect(retrieved?.csrfToken).toBe(stale.csrfToken);
    });

    it("persists the minted token to the session store", async () => {
      const mint = vi.fn(async () => ({ ok: true, accessToken: "fresh-jwt" }) as const);
      const manager = makeManager(mint);
      await manager.setToken(expiredWithCookies());

      await manager.getToken();

      const persisted = await new SessionStore(testDir).load();
      expect(persisted?.accessToken).toBe("fresh-jwt");
      expect(persisted?.csrfToken).toBe("xsrf-123");
    });

    it("does not mint when the expired token carries no session material", async () => {
      const mint = vi.fn(async () => ({ ok: true, accessToken: "fresh-jwt" }) as const);
      const manager = makeManager(mint);
      await manager.setToken({
        accessToken: "stale-jwt",
        capturedAt: Date.now() - 7200000,
        expiresAt: Date.now() - 3600000,
        source: "browser",
      });

      const retrieved = await manager.getToken();

      expect(retrieved).toBeNull();
      expect(mint).not.toHaveBeenCalled();
    });

    it("does not mint when no base URL is configured", async () => {
      const mint = vi.fn(async () => ({ ok: true, accessToken: "fresh-jwt" }) as const);
      const manager = new TokenManager({ sessionDir: testDir, mint });
      await manager.setToken(expiredWithCookies());

      const retrieved = await manager.getToken();

      expect(retrieved).toBeNull();
      expect(mint).not.toHaveBeenCalled();
    });

    it("clears the store when the session itself has expired", async () => {
      const mint = vi.fn(
        async () => ({ ok: false, reason: "sessionExpired" }) as const
      );
      const manager = makeManager(mint);
      await manager.setToken(expiredWithCookies());

      const retrieved = await manager.getToken();

      expect(retrieved).toBeNull();
      expect(await new SessionStore(testDir).load()).toBeNull();
    });

    it("keeps the stored token on a transport failure", async () => {
      const mint = vi.fn(
        async () =>
          ({ ok: false, reason: "transport", detail: "HTTP 503" }) as const
      );
      const manager = makeManager(mint);
      await manager.setToken(expiredWithCookies());

      const retrieved = await manager.getToken();

      expect(retrieved).toBeNull();
      expect(await new SessionStore(testDir).load()).not.toBeNull();
    });

    it("mints once for two concurrent getToken calls", async () => {
      let resolveMint: (value: { ok: true; accessToken: string }) => void = () => {};
      const mint = vi.fn(
        () =>
          new Promise<{ ok: true; accessToken: string }>((resolve) => {
            resolveMint = resolve;
          })
      );
      const manager = makeManager(mint as unknown as MintFn);
      await manager.setToken(expiredWithCookies());

      const both = Promise.all([manager.getToken(), manager.getToken()]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      resolveMint({ ok: true, accessToken: "fresh-jwt" });
      const [first, second] = await both;

      expect(mint).toHaveBeenCalledTimes(1);
      expect(first?.accessToken).toBe("fresh-jwt");
      expect(second?.accessToken).toBe("fresh-jwt");
    });

    it("still accepts the positional session directory constructor", async () => {
      const positional = new TokenManager(testDir);
      const validToken: TokenData = {
        accessToken: "valid",
        capturedAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000,
        source: "browser",
      };

      await positional.setToken(validToken);

      expect(await positional.getToken()).toEqual(validToken);
    });
  });
});
