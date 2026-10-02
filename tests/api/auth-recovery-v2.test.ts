import { afterEach, describe, expect, it, vi } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import { TokenManager, type TokenManagerOptions } from "../../src/auth/token-manager.js";
import { TokenRefreshError } from "../../src/api/errors.js";
import type { TokenData } from "../../src/types/index.js";

const path = "/d2l/api/lp/1.62/users/whoami";
const baseUrl = "https://purdue.brightspace.com";
const token = (): TokenData => ({
  accessToken: "old-jwt", capturedAt: Date.now() - 7200000,
  tenantOrigin: baseUrl,
  expiresAt: Date.now() - 3600000, source: "browser",
  cookieHeader: "d2lSessionVal=test-cookie", csrfToken: "test-xsrf",
});

function fixture(mint: NonNullable<TokenManagerOptions["mint"]>) {
  let saved: TokenData | null = token();
  const sessionStore = {
    load: vi.fn(async () => saved),
    save: vi.fn(async (next: TokenData) => { saved = next; }),
    clear: vi.fn(async () => { saved = null; }),
    saveIfCurrent: vi.fn(async (next: TokenData, expected: TokenData) => {
      if (saved !== expected) return false;
      saved = next;
      return true;
    }),
    clearIfCurrent: vi.fn(async (expected: TokenData) => {
      if (saved !== expected) return false;
      saved = null;
      return true;
    }),
  };
  const manager = new TokenManager({ baseUrl, mint, sessionStore });
  const authenticate = vi.fn(async () => {
    await sessionStore.save({ ...token(), accessToken: "login-jwt", expiresAt: Date.now() + 3600000 });
    return true;
  });
  const client = new D2LApiClient({
    baseUrl, tokenManager: manager, onAuthExpired: authenticate,
    retry: { maxAttempts: 1 }, rateLimitConfig: { capacity: 100, refillRate: 100 },
  });
  return { sessionStore, manager, authenticate, client };
}

afterEach(() => vi.unstubAllGlobals());

describe("v2 authentication recovery", () => {
  it.each(["get", "getRaw"] as const)("%s preserves the session and skips MFA when minting has an outage", async method => {
    const state = fixture(vi.fn(async () => ({ ok: false, reason: "transport", detail: "HTTP 503" })));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(state.client[method](path)).rejects.toBeInstanceOf(TokenRefreshError);
    expect(state.authenticate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.sessionStore.clear).not.toHaveBeenCalled();
    expect(await state.sessionStore.load()).not.toBeNull();
  });

  it.each(["get", "getRaw"] as const)("%s refreshes a rejected JWT over HTTP before asking for MFA", async method => {
    const mint = vi.fn(async () => ({ ok: true, accessToken: "mint-jwt" }) as const);
    const state = fixture(mint);
    await state.manager.setToken({ ...token(), expiresAt: Date.now() + 3600000 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ Identifier: "42" }));
    vi.stubGlobal("fetch", fetchMock);

    await state.client[method](path);

    expect(mint).toHaveBeenCalledTimes(1);
    expect(state.authenticate).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer mint-jwt");
    expect(await state.sessionStore.load()).toMatchObject({ accessToken: "mint-jwt" });
  });

  it("a mint outage after a 401 still never starts MFA", async () => {
    const state = fixture(vi.fn(async () => ({ ok: false, reason: "transport", detail: "timeout" })));
    await state.manager.setToken({ ...token(), expiresAt: Date.now() + 3600000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));

    await expect(state.client.get(path)).rejects.toBeInstanceOf(TokenRefreshError);
    expect(state.authenticate).not.toHaveBeenCalled();
    expect(await state.sessionStore.load()).not.toBeNull();
  });

  it("a permission 403 does not clear the session or start MFA", async () => {
    const mint = vi.fn(async () => ({ ok: true, accessToken: "unused" }) as const);
    const state = fixture(mint);
    await state.manager.setToken({ ...token(), expiresAt: Date.now() + 3600000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })));

    await expect(state.client.get(path)).rejects.toMatchObject({ status: 403 });
    expect(state.authenticate).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(await state.sessionStore.load()).not.toBeNull();
  });

  it("confirmed cookie expiry starts one login and loads the child's persisted token", async () => {
    const state = fixture(vi.fn(async () => ({ ok: false, reason: "sessionExpired" })));
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ Identifier: "42" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await state.client.get(path)).toEqual({ Identifier: "42" });
    expect(state.authenticate).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer login-jwt");
  });

  it("a post-login 401 does not create an infinite MFA loop", async () => {
    const state = fixture(vi.fn(async () => ({ ok: false, reason: "sessionExpired" })));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));

    await expect(state.client.get(path)).rejects.toMatchObject({ status: 401 });
    expect(state.authenticate).toHaveBeenCalledTimes(1);
  });

  it("counts one token refresh, not two, when the minted retry also 401s before login", async () => {
    const mint = vi.fn(async () => ({ ok: true, accessToken: "mint-jwt" }) as const);
    const state = fixture(mint);
    await state.manager.setToken({ ...token(), expiresAt: Date.now() + 3600000 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 })) // the stale token
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 })) // the minted retry
      .mockResolvedValueOnce(Response.json({ Identifier: "42" })); // the post-login token
    vi.stubGlobal("fetch", fetchMock);

    const result = await state.client.get(path);

    expect(result).toEqual({ Identifier: "42" });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(state.authenticate).toHaveBeenCalledTimes(1);
    expect(state.client.stats().tokenRefreshes).toBe(1);
  });
});
