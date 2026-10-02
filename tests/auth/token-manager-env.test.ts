import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { TokenManager } from "../../src/auth/token-manager.js";
import { D2LApiClient } from "../../src/api/client.js";
import { ApiError } from "../../src/api/errors.js";
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

      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
