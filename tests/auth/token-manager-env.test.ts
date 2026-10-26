import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { TokenManager } from "../../src/auth/token-manager.js";
import { D2LApiClient } from "../../src/api/client.js";
import { ApiError, CredentialRejectedError } from "../../src/api/errors.js";
import { AuthRunner } from "../../src/auth/auth-runner.js";

// D2L_ACCESS_TOKEN / D2L_SESSION_COOKIE never touch disk, so no SessionStore
// mock is needed here (unlike token-manager.test.ts) — these tests prove that
// by never exercising session-store I/O in the first place.

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));

const BASE_URL = "https://purdue.brightspace.com";

describe("TokenManager — D2L_ACCESS_TOKEN / D2L_SESSION_COOKIE", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `token-manager-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    vi.mocked(spawn).mockClear();
  });

  describe("D2L_ACCESS_TOKEN", () => {
    it("is used directly as a Bearer token, with no disk, mint, or browser involved", async () => {
      const manager = new TokenManager({ sessionDir: testDir, baseUrl: BASE_URL, envAccessToken: "my-admin-token" });
      const token = await manager.getToken();

      expect(token).toMatchObject({ accessToken: "my-admin-token", source: "env", tenantOrigin: BASE_URL });
      expect(token?.cookieHeader).toBeUndefined();
    });

    it("keeps returning the same token across repeated calls", async () => {
      const manager = new TokenManager({ sessionDir: testDir, baseUrl: BASE_URL, envAccessToken: "my-admin-token" });
      const first = await manager.getToken();
      const second = await manager.getToken();

      expect(first?.accessToken).toBe("my-admin-token");
      expect(second?.accessToken).toBe("my-admin-token");
    });

    it("returns null once Brightspace rejects it, instead of handing back the same rejected value", async () => {
      const manager = new TokenManager({ sessionDir: testDir, baseUrl: BASE_URL, envAccessToken: "my-admin-token" });
      await manager.getToken();

      const retried = await manager.getToken("my-admin-token");

      expect(retried).toBeNull();
    });

    it("takes precedence over D2L_SESSION_COOKIE when both are set", async () => {
      const manager = new TokenManager({
        sessionDir: testDir,
        baseUrl: BASE_URL,
        envAccessToken: "my-admin-token",
        envSessionCookie: "d2lSessionVal=aaa; d2lSecureSessionVal=bbb",
      });

      const token = await manager.getToken();

      expect(token?.accessToken).toBe("my-admin-token");
      expect(token?.source).toBe("env");
    });
  });

  describe("D2L_SESSION_COOKIE", () => {
    const COOKIE = "d2lSessionVal=aaa; d2lSecureSessionVal=bbb";

    it("is used as-is via the client's cookie passthrough, never minted into a Bearer JWT", async () => {
      const manager = new TokenManager({ sessionDir: testDir, baseUrl: BASE_URL, envSessionCookie: COOKIE });
      const token = await manager.getToken();

      expect(token).toMatchObject({ accessToken: `cookie:${COOKIE}`, cookieHeader: COOKIE, source: "env", tenantOrigin: BASE_URL });
    });

    it("returns null once Brightspace rejects it", async () => {
      const manager = new TokenManager({ sessionDir: testDir, baseUrl: BASE_URL, envSessionCookie: COOKIE });
      const token = await manager.getToken();

      const retried = await manager.getToken(token!.accessToken);

      expect(retried).toBeNull();
    });
  });

  describe("D2L_SESSION_COOKIE with mintEnvCookie", () => {
    const COOKIE = "d2lSessionVal=aaa; d2lSecureSessionVal=bbb";

    const makeManager = (
      fetchXsrf: ReturnType<typeof vi.fn>,
      mint: ReturnType<typeof vi.fn>,
    ) =>
      new TokenManager({
        sessionDir: testDir,
        baseUrl: BASE_URL,
        envSessionCookie: COOKIE,
        mintEnvCookie: true,
        fetchXsrf: fetchXsrf as never,
        mint: mint as never,
      });

    it("trades the cookie for a Bearer JWT using the XSRF token read off the home page", async () => {
      const fetchXsrf = vi.fn(async () => ({ ok: true as const, csrfToken: "xsrf-1" }));
      const mint = vi.fn(async () => ({ ok: true as const, accessToken: "minted-jwt" }));
      const manager = makeManager(fetchXsrf, mint);

      const token = await manager.getToken();

      expect(token).toMatchObject({ accessToken: "minted-jwt", source: "env", cookieHeader: COOKIE, tenantOrigin: BASE_URL });
      expect(mint).toHaveBeenCalledWith({ baseUrl: BASE_URL, cookieHeader: COOKIE, csrfToken: "xsrf-1" });
    });

    it("serves the minted JWT from memory until it is rejected, then mints again", async () => {
      const fetchXsrf = vi.fn(async () => ({ ok: true as const, csrfToken: "xsrf-1" }));
      const mint = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, accessToken: "jwt-1" })
        .mockResolvedValueOnce({ ok: true, accessToken: "jwt-2" });
      const manager = makeManager(fetchXsrf, mint);

      expect((await manager.getToken())?.accessToken).toBe("jwt-1");
      expect((await manager.getToken())?.accessToken).toBe("jwt-1");
      expect((await manager.getToken("jwt-1"))?.accessToken).toBe("jwt-2");
      expect(mint).toHaveBeenCalledTimes(2);
      // The XSRF token that worked is reused instead of fetching the page again.
      expect(fetchXsrf).toHaveBeenCalledTimes(1);
    });

    it("shares one mint between concurrent callers", async () => {
      const fetchXsrf = vi.fn(async () => ({ ok: true as const, csrfToken: "xsrf-1" }));
      const mint = vi.fn(async () => ({ ok: true as const, accessToken: "minted-jwt" }));
      const manager = makeManager(fetchXsrf, mint);

      const [a, b] = await Promise.all([manager.getToken(), manager.getToken()]);

      expect(a?.accessToken).toBe("minted-jwt");
      expect(b?.accessToken).toBe("minted-jwt");
      expect(mint).toHaveBeenCalledTimes(1);
    });

    it("falls back to the cookie passthrough, and stops trying, when the page has no XSRF token", async () => {
      const fetchXsrf = vi.fn(async () => ({ ok: false as const, reason: "notFound" as const }));
      const mint = vi.fn();
      const manager = makeManager(fetchXsrf, mint);

      expect((await manager.getToken())?.accessToken).toBe(`cookie:${COOKIE}`);
      expect((await manager.getToken())?.accessToken).toBe(`cookie:${COOKIE}`);
      expect(fetchXsrf).toHaveBeenCalledTimes(1);
      expect(mint).not.toHaveBeenCalled();
    });

    it("keeps the paste-a-fresh-one path for a dead cookie", async () => {
      const fetchXsrf = vi.fn(async () => ({ ok: false as const, reason: "sessionExpired" as const }));
      const manager = makeManager(fetchXsrf, vi.fn());

      const token = await manager.getToken();
      expect(token?.accessToken).toBe(`cookie:${COOKIE}`);
      expect(await manager.getToken(token!.accessToken)).toBeNull();
    });

    it("falls back to the cookie when the mint refuses, and retries after a transport failure", async () => {
      vi.useFakeTimers();
      try {
        const fetchXsrf = vi.fn(async () => ({ ok: true as const, csrfToken: "xsrf-1" }));
        const mint = vi
          .fn()
          .mockResolvedValueOnce({ ok: false, reason: "transport", detail: "HTTP 403" })
          .mockResolvedValueOnce({ ok: true, accessToken: "minted-jwt" });
        const manager = makeManager(fetchXsrf, mint);

        expect((await manager.getToken())?.accessToken).toBe(`cookie:${COOKIE}`);
        expect((await manager.getToken())?.accessToken).toBe(`cookie:${COOKIE}`);
        expect(mint).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(61_000);
        expect((await manager.getToken())?.accessToken).toBe("minted-jwt");
        // The refused XSRF token was dropped, so a fresh one was read.
        expect(fetchXsrf).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("is off by default, so read-only callers make no requests", async () => {
      const fetchXsrf = vi.fn();
      const manager = new TokenManager({ sessionDir: testDir, baseUrl: BASE_URL, envSessionCookie: COOKIE, fetchXsrf: fetchXsrf as never });

      expect((await manager.getToken())?.accessToken).toBe(`cookie:${COOKIE}`);
      expect(fetchXsrf).not.toHaveBeenCalled();
    });

    it("never mints when D2L_ACCESS_TOKEN is also set", async () => {
      const fetchXsrf = vi.fn();
      const manager = new TokenManager({
        sessionDir: testDir,
        baseUrl: BASE_URL,
        envAccessToken: "my-admin-token",
        envSessionCookie: COOKIE,
        mintEnvCookie: true,
        fetchXsrf: fetchXsrf as never,
      });

      expect((await manager.getToken())?.accessToken).toBe("my-admin-token");
      expect(fetchXsrf).not.toHaveBeenCalled();
    });
  });

  describe("byte-identical behavior when neither variable is set", () => {
    it("falls through to the ordinary disk-backed flow and returns null with nothing cached", async () => {
      const manager = new TokenManager({ sessionDir: testDir, baseUrl: BASE_URL });
      expect(await manager.getToken()).toBeNull();
    });
  });

  describe("end-to-end: a 401 under env auth never spawns auth-cli", () => {
    const makeEnvClient = (tokenManager: TokenManager, authExpiredMessage: string) =>
      new D2LApiClient({
        baseUrl: BASE_URL,
        tokenManager,
        // index.ts never wires onAuthExpired when env auth is active — there is
        // no stored credential to drive a browser login from.
        authExpiredMessage,
      });

    let originalFetch: typeof global.fetch;
    beforeEach(() => {
      originalFetch = global.fetch;
    });
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("reports the pasted cookie as expired and never calls AuthRunner", async () => {
      const tokenManager = new TokenManager({
        sessionDir: testDir,
        baseUrl: BASE_URL,
        envSessionCookie: "d2lSessionVal=aaa; d2lSecureSessionVal=bbb",
      });
      // Demonstrates the guarantee concretely: an AuthRunner exists in this
      // process (as it would if something were mis-wired), but the auth-cli
      // child it would spawn is never invoked.
      const authRunner = new AuthRunner();
      void authRunner;

      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
        headers: new Headers(),
      })) as unknown as typeof fetch;
      const client = makeEnvClient(
        tokenManager,
        "The pasted D2L_SESSION_COOKIE has expired. Copy a fresh d2lSessionVal/d2lSecureSessionVal pair and paste a fresh one.",
      );
      await client.initialize();

      global.fetch = vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
        headers: new Headers(),
      })) as unknown as typeof fetch;

      await expect(client.get("/d2l/api/lp/1.56/users/whoami")).rejects.toMatchObject({
        status: 401,
        message: expect.stringContaining("paste a fresh one"),
      } as Partial<ApiError>);
      await expect(client.get("/d2l/api/lp/1.56/users/whoami")).rejects.toBeInstanceOf(CredentialRejectedError);

      expect(spawn).not.toHaveBeenCalled();
    });

    it("reports D2L_ACCESS_TOKEN as expired/invalid and never calls AuthRunner", async () => {
      const tokenManager = new TokenManager({ sessionDir: testDir, baseUrl: BASE_URL, envAccessToken: "admin-issued-token" });

      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { ProductCode: "lp", LatestVersion: "1.56" },
          { ProductCode: "le", LatestVersion: "1.91" },
        ],
        headers: new Headers(),
      })) as unknown as typeof fetch;
      const client = makeEnvClient(
        tokenManager,
        "D2L_ACCESS_TOKEN was rejected by Brightspace (expired or invalid). Issue a fresh token.",
      );
      await client.initialize();

      global.fetch = vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
        headers: new Headers(),
      })) as unknown as typeof fetch;

      await expect(client.get("/d2l/api/lp/1.56/users/whoami")).rejects.toMatchObject({
        status: 401,
        message: expect.stringContaining("expired or invalid"),
      } as Partial<ApiError>);
      await expect(client.get("/d2l/api/lp/1.56/users/whoami")).rejects.toBeInstanceOf(CredentialRejectedError);

      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
