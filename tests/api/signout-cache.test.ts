import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { D2LApiClient } from "../../src/api/client.js";
import { TokenManager } from "../../src/auth/token-manager.js";
import { SessionStore, SESSION_FILE } from "../../src/auth/session-store.js";
import type { TokenData } from "../../src/types/index.js";
import { MemoryCredentialBackend, retireTestFile } from "../auth/secure-store-fixtures.js";

const BASE_URL = "https://purdue.brightspace.com";
const VERSIONS_URL = `${BASE_URL}/d2l/api/versions/`;

const token = (): TokenData => ({
  accessToken: "test-token-12345678",
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser",
});

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const versionsResponse = () => jsonResponse([{ ProductCode: "lp", LatestVersion: "1.56" }, { ProductCode: "le", LatestVersion: "1.91" }]);

/** After sign-out a running server must not answer from memory either. */
describe("D2LApiClient after the saved session is signed out", () => {
  let fetched: string[];
  let originalFetch: typeof global.fetch;
  let signedOut: boolean;
  let signedOutChecks: number;
  let tokenAvailable: boolean;

  const tokenManager = {
    async getToken() { return tokenAvailable ? token() : null; },
    async sessionChanged() { signedOutChecks++; return signedOut; },
  } as unknown as TokenManager;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetched = [];
    signedOut = false;
    signedOutChecks = 0;
    tokenAvailable = true;
    global.fetch = (async (url: string) => {
      fetched.push(url);
      if (url === VERSIONS_URL) return versionsResponse();
      return jsonResponse({ call: fetched.length });
    }) as unknown as typeof global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const apiCalls = () => fetched.filter((url) => url !== VERSIONS_URL);

  it("still serves a cached read while signed in", async () => {
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager });
    const first = await client.get(client.lp("/users/whoami"), { ttl: 60_000 });
    const second = await client.get(client.lp("/users/whoami"), { ttl: 60_000 });

    expect(second).toEqual(first);
    expect(apiCalls()).toHaveLength(1);
  });

  it("does not serve a cached response once the session is signed out", async () => {
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager });
    await client.get(client.lp("/users/whoami"), { ttl: 60_000 });
    expect(client.cacheSize).toBe(1);

    signedOut = true;
    tokenAvailable = false;

    // The read goes down the normal path, which finds no token and (with no
    // sign-in callback configured) reports the session as expired.
    await expect(client.get(client.lp("/users/whoami"), { ttl: 60_000 })).rejects.toMatchObject({ name: "ApiError", status: 401 });
    expect(client.cacheSize).toBe(0);
    expect(apiCalls()).toHaveLength(1);
  });

  it("fetches fresh data after sign-out and sign-in again", async () => {
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager });
    const before = await client.get(client.lp("/users/whoami"), { ttl: 60_000 });

    signedOut = true;
    await client.get(client.lp("/users/whoami"), { ttl: 60_000 }); // cache dropped, refetched
    signedOut = false;
    const after = await client.get(client.lp("/users/whoami"), { ttl: 60_000 });

    expect(apiCalls()).toHaveLength(2);
    expect(after).not.toEqual(before);
  });

  it("does not look at the session when there is nothing cached", async () => {
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager });
    await client.get(client.lp("/users/whoami"), { ttl: 60_000 });
    expect(signedOutChecks).toBe(0);
  });

  it("works with a token manager that cannot report sign-out", async () => {
    const plain = { async getToken() { return token(); } } as unknown as TokenManager;
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager: plain });
    await client.get(client.lp("/users/whoami"), { ttl: 60_000 });
    await client.get(client.lp("/users/whoami"), { ttl: 60_000 });
    expect(apiCalls()).toHaveLength(1);
  });

  describe("a read already in flight when the cache is cleared", () => {
    /** Holds the response for `/slow` until released. */
    let release: () => void;
    let slowStarted: Promise<void>;

    beforeEach(() => {
      let started: () => void;
      slowStarted = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      global.fetch = (async (url: string) => {
        fetched.push(url);
        if (url === VERSIONS_URL) return versionsResponse();
        if (url.endsWith("/slow")) {
          started();
          await gate;
          return jsonResponse({ from: "before-sign-out" });
        }
        return jsonResponse({ call: fetched.length });
      }) as unknown as typeof global.fetch;
    });

    it("does not write its late result into the cache after clearCache()", async () => {
      const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager });
      const pending = client.get("/slow", { ttl: 60_000 });
      await slowStarted;

      client.clearCache(); // what sign_out does
      release();

      // The caller that asked before the sign-out still gets its answer...
      await expect(pending).resolves.toEqual({ from: "before-sign-out" });
      // ...but nothing is remembered for anyone who asks afterwards.
      expect(client.cacheSize).toBe(0);
    });

    it("does not let a later caller join the old request", async () => {
      const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager });
      const old = client.get("/slow", { ttl: 60_000 });
      await slowStarted;

      client.clearCache();
      const fresh = client.get("/slow", { ttl: 60_000 });
      release();
      await Promise.all([old, fresh]);

      expect(fetched.filter((url) => url.endsWith("/slow"))).toHaveLength(2);
    });

    it("still caches a read that began after the clear", async () => {
      const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager });
      client.clearCache();
      release();
      await client.get("/slow", { ttl: 60_000 });
      expect(client.cacheSize).toBe(1);
    });

    it("applies the same rule when the sign-out is detected by the cache check itself", async () => {
      const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager });
      release();
      await client.get(client.lp("/users/whoami"), { ttl: 60_000 }); // something cached so the check runs
      const gate2 = new Promise<void>((resolve) => { release = resolve; });
      global.fetch = (async (url: string) => {
        fetched.push(url);
        if (url.endsWith("/slow")) { await gate2; return jsonResponse({ from: "before-sign-out" }); }
        return jsonResponse({ call: fetched.length });
      }) as unknown as typeof global.fetch;

      const pending = client.get("/slow", { ttl: 60_000 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      signedOut = true;
      await client.get(client.lp("/users/whoami"), { ttl: 60_000 }); // detects the sign-out, clears
      release();
      await pending;

      expect(client.cacheSize).toBe(1); // only the read made after the detection
    });
  });
});

/**
 * The same behavior end to end: a real TokenManager over a real session file,
 * as another process (the CLI, a second server) signs out, signs in as someone
 * else, or quietly re-mints the same account's token.
 */
describe("D2LApiClient with a real TokenManager and session file", () => {
  let dir: string;
  let backend: MemoryCredentialBackend;
  let other: SessionStore;
  let originalFetch: typeof global.fetch;
  let apiCalls: number;
  let client: D2LApiClient;

  const alice = (accessToken: string, extra: Partial<TokenData> = {}): TokenData => ({
    accessToken,
    tenantOrigin: BASE_URL,
    capturedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    source: "browser",
    uniqueName: "alice@purdue.edu",
    cookieHeader: `d2lSessionVal=${accessToken}`,
    csrfToken: "xsrf",
    ...extra,
  });
  const read = () => client.get(client.lp("/users/whoami"), { ttl: 60_000 });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "signout-cache-"));
    backend = new MemoryCredentialBackend();
    other = new SessionStore(dir, { backend, trash: retireTestFile });
    originalFetch = global.fetch;
    apiCalls = 0;
    global.fetch = (async (url: string) => {
      if (url === VERSIONS_URL) return versionsResponse();
      apiCalls++;
      return jsonResponse({ call: apiCalls });
    }) as unknown as typeof global.fetch;

    const tokenManager = new TokenManager({ baseUrl: BASE_URL, sessionStore: new SessionStore(dir, { backend, trash: retireTestFile }) });
    await tokenManager.setToken(alice("alice-token-12345678"));
    client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager });
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("serves a cached read while the session file is unchanged", async () => {
    await read();
    await read();
    expect(apiCalls).toBe(1);
  });

  it("does not serve the cache after the session file is deleted", async () => {
    await read();
    await fs.unlink(path.join(dir, SESSION_FILE));

    await expect(read()).rejects.toMatchObject({ status: 401 });
    expect(apiCalls).toBe(1);
    expect(client.cacheSize).toBe(0);
  });

  it("refetches after another account signs in over the same file", async () => {
    await read();
    await fs.unlink(path.join(dir, SESSION_FILE));
    await other.save(alice("bob-token-12345678", { uniqueName: "bob@purdue.edu", cookieHeader: "d2lSessionVal=bob" }));

    const result = await read();

    expect(apiCalls).toBe(2);
    expect(result).toEqual({ call: 2 });
  });

  it("keeps serving the cache when another process re-mints the same account's token", async () => {
    await read();
    await other.save(alice("alice-reminted-1234567", { cookieHeader: "d2lSessionVal=alice-new-cookie" }));

    await read();

    expect(apiCalls).toBe(1);
  });
});
