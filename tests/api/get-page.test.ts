import { describe, it, expect, vi, afterEach } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";

/**
 * Brightspace web pages (an LTI quickLink, a tool launch) check the session
 * cookie and ignore a Bearer token, so getPage() sends the stored cookie.
 * A read-only page fetch is never worth an MFA prompt, so it never logs in.
 */

const SESSION_COOKIE = "d2lSessionVal=abc; d2lSecureSessionVal=def";
const EXPIRED_STUB =
  '<html><head><script>window.location.replace("/d2l/login?sessionExpired=1");</script></head></html>';

const browserToken = (overrides: Partial<TokenData> = {}): TokenData => ({
  accessToken: "eyJ.jwt.sig",
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser",
  cookieHeader: SESSION_COOKIE,
  ...overrides,
});

function makeClient(token: TokenData) {
  const fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  const tokenManager = { getToken: vi.fn(async () => token) } as unknown as TokenManager;
  const onAuthExpired = vi.fn(async () => true);
  const client = new D2LApiClient({ baseUrl: "https://purdue.brightspace.com", tokenManager, onAuthExpired });
  return { client, fetchMock, onAuthExpired };
}

const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

describe("D2LApiClient.getPage", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the session cookie and no Bearer token", async () => {
    const { client, fetchMock } = makeClient(browserToken());
    fetchMock.mockResolvedValue(html("<html>launch</html>"));

    const page = await client.getPage("/d2l/common/dialogs/quickLink/quickLink.d2l?rcode=X");

    expect(page).toBe("<html>launch</html>");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://purdue.brightspace.com/d2l/common/dialogs/quickLink/quickLink.d2l?rcode=X");
    expect(init.headers.Cookie).toBe(SESSION_COOKIE);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("returns null without a request when no session cookie is stored", async () => {
    const { client, fetchMock } = makeClient(browserToken({ cookieHeader: undefined }));

    expect(await client.getPage("/d2l/le/lti/101/toolLaunch/77")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on the login redirect instead of opening a browser login", async () => {
    const { client, fetchMock, onAuthExpired } = makeClient(browserToken());
    fetchMock.mockResolvedValue(html(EXPIRED_STUB));

    expect(await client.getPage("/d2l/le/lti/101/toolLaunch/77")).toBeNull();
    expect(onAuthExpired).not.toHaveBeenCalled();
  });
});
