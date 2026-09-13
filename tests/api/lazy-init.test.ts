/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import { NetworkError } from "../../src/api/errors.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";

/**
 * Nothing about starting the server should touch Brightspace. API versions are
 * discovered, and a missing session is signed back in, by whichever request
 * first needs them, so a user who never asks about a course never triggers a
 * network call or an MFA prompt.
 */

const BASE_URL = "https://purdue.brightspace.com";
const VERSIONS_URL = `${BASE_URL}/d2l/api/versions/`;

const token = (accessToken = "test-token-12345678"): TokenData => ({
  accessToken,
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser",
});

/** A token manager whose answers a test can change between calls. */
function tokenManagerReturning(...answers: Array<TokenData | null>): TokenManager {
  const queue = [...answers];
  return {
    async getToken() {
      return queue.length > 1 ? queue.shift()! : queue[0] ?? null;
    },
  } as unknown as TokenManager;
}

const versionsBody = [
  { ProductCode: "lp", LatestVersion: "1.56" },
  { ProductCode: "le", LatestVersion: "1.91" },
];

const versionsResponse = () => ({ ok: true, status: 200, json: async () => versionsBody });

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const binaryResponse = () => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/pdf" }),
});

describe("lazy initialization", () => {
  let fetched: string[];
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  /** Answer version discovery, and hand every other URL the same payload. */
  function routeFetch(payload: unknown = { ok: true }) {
    mockFetch.mockImplementation(async (url: string) => {
      fetched.push(url);
      return url === VERSIONS_URL ? versionsResponse() : jsonResponse(payload);
    });
  }

  beforeEach(() => {
    originalFetch = global.fetch;
    fetched = [];
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reaches the network for nothing when the client is constructed", () => {
    new D2LApiClient({ baseUrl: BASE_URL, tokenManager: tokenManagerReturning(token()) });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("discovers versions on the first request and substitutes them into the path", async () => {
    routeFetch();
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager: tokenManagerReturning(token()) });

    await client.get(client.lp("/users/whoami"));

    expect(fetched).toEqual([VERSIONS_URL, `${BASE_URL}/d2l/api/lp/1.56/users/whoami`]);
    expect(client.apiVersions).toEqual({ lp: "1.56", le: "1.91" });
  });

  it("substitutes the LE version into a download path too", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      fetched.push(url);
      return url === VERSIONS_URL ? versionsResponse() : binaryResponse();
    });
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager: tokenManagerReturning(token()) });

    await client.getRaw(client.le(123456, "/content/topics/789/file"));

    expect(fetched).toEqual([
      VERSIONS_URL,
      `${BASE_URL}/d2l/api/le/1.91/123456/content/topics/789/file`,
    ]);
  });

  it("discovers once for concurrent first requests", async () => {
    routeFetch();
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager: tokenManagerReturning(token()) });

    await Promise.all([
      client.get(client.lp("/users/whoami")),
      client.get(client.leGlobal("/enrollments/myenrollments/")),
      client.get(client.le(42, "/grades/")),
    ]);

    expect(fetched.filter(url => url === VERSIONS_URL)).toHaveLength(1);
    expect(fetched).toHaveLength(4);
  });

  it("discovers once across later requests", async () => {
    routeFetch();
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager: tokenManagerReturning(token()) });

    await client.get(client.lp("/users/whoami"));
    await client.get(client.le(42, "/grades/"));

    expect(fetched.filter(url => url === VERSIONS_URL)).toHaveLength(1);
  });

  it("retries a failed discovery instead of replaying the rejection", async () => {
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager: tokenManagerReturning(token()) });
    mockFetch.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));

    await expect(client.get(client.lp("/users/whoami"))).rejects.toThrow(NetworkError);

    routeFetch({ FirstName: "Elliot" });
    await expect(client.get(client.lp("/users/whoami"))).resolves.toEqual({ FirstName: "Elliot" });
  });

  it("serves a cached response without discovering versions or reading a token", async () => {
    routeFetch({ cached: true });
    const tokenManager = tokenManagerReturning(token());
    const getToken = vi.spyOn(tokenManager, "getToken");
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager });
    const path = client.le(42, "/grades/");

    await client.get(path, { ttl: 60_000 });
    const callsAfterFirst = mockFetch.mock.calls.length;
    const tokenReadsAfterFirst = getToken.mock.calls.length;

    await expect(client.get(path, { ttl: 60_000 })).resolves.toEqual({ cached: true });

    expect(mockFetch.mock.calls).toHaveLength(callsAfterFirst);
    expect(getToken.mock.calls).toHaveLength(tokenReadsAfterFirst);
  });

  it("skips discovery for a path that carries no version placeholder", async () => {
    routeFetch();
    const client = new D2LApiClient({ baseUrl: BASE_URL, tokenManager: tokenManagerReturning(token()) });

    // D2L hands back fully-resolved next-page URLs, which paginate.ts passes
    // straight through. Those must not provoke a discovery of their own.
    await client.get("/d2l/api/le/1.91/classlist/paged/?bookmark=abc");

    expect(fetched).toEqual([`${BASE_URL}/d2l/api/le/1.91/classlist/paged/?bookmark=abc`]);
  });

  it("signs in on the first request when there is no saved session", async () => {
    routeFetch({ Items: [] });
    const onAuthExpired = vi.fn(async () => true);
    // No token until the sign-in has run, exactly as a cold start looks.
    const client = new D2LApiClient({
      baseUrl: BASE_URL,
      tokenManager: tokenManagerReturning(null, token("fresh-token-12345678")),
      onAuthExpired,
    });

    await expect(client.get(client.lp("/users/whoami"))).resolves.toEqual({ Items: [] });

    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls.at(-1) as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fresh-token-12345678");
  });

  it("reports the sign-in failure rather than a bare 401 when it cannot authenticate", async () => {
    routeFetch();
    const client = new D2LApiClient({
      baseUrl: BASE_URL,
      tokenManager: tokenManagerReturning(null),
      onAuthExpired: async () => {
        throw new Error("MFA was not approved");
      },
    });

    await expect(client.get(client.lp("/users/whoami"))).rejects.toThrow("MFA was not approved");
    // The sign-in failed before the request went out, so only discovery ran.
    expect(fetched).toEqual([VERSIONS_URL]);
  });
});
