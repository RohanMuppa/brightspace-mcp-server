import { describe, it, expect } from "vitest";
import { mintAccessToken } from "../../src/auth/token-mint.js";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/**
 * Build a fetch stub that records what it was asked to send and answers with a
 * fixed status and body. Only the two members mintAccessToken reads are faked.
 */
function stubFetch(
  answer: { status: number; body: string } | { throws: Error }
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if ("throws" in answer) throw answer.throws;
    return {
      status: answer.status,
      text: async () => answer.body,
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const BASE_URL = "https://purdue.brightspace.com";
const COOKIE_HEADER = "d2lSessionVal=aaa; d2lSecureSessionVal=bbb";
const CSRF_TOKEN = "xsrf-123";

const mint = (fetchImpl: typeof fetch) =>
  mintAccessToken({
    baseUrl: BASE_URL,
    cookieHeader: COOKIE_HEADER,
    csrfToken: CSRF_TOKEN,
    fetchImpl,
  });

describe("mintAccessToken", () => {
  it("returns the access token on a 200 JSON answer", async () => {
    const { fetchImpl } = stubFetch({
      status: 200,
      body: JSON.stringify({ access_token: "minted-jwt" }),
    });

    const result = await mint(fetchImpl);

    expect(result).toEqual({ ok: true, accessToken: "minted-jwt" });
  });

  it("sends the cookie, the CSRF header and the wildcard scope body", async () => {
    const { fetchImpl, calls } = stubFetch({
      status: 200,
      body: JSON.stringify({ access_token: "minted-jwt" }),
    });

    await mint(fetchImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE_URL}/d2l/lp/auth/oauth2/token`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe("scope=*:*:*");

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["cookie"]).toBe(COOKIE_HEADER);
    expect(headers["x-csrf-token"]).toBe(CSRF_TOKEN);
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["User-Agent"]).toContain("BrightspaceMCP");
  });

  it("classifies the HTTP 200 expiry stub as sessionExpired", async () => {
    // A dead session answers 200 with an HTML redirect stub, never a 401.
    const { fetchImpl } = stubFetch({
      status: 200,
      body: '<html><script>location="/d2l/login?sessionExpired=1"</script></html>',
    });

    const result = await mint(fetchImpl);

    expect(result).toEqual({ ok: false, reason: "sessionExpired" });
  });

  it("checks the expiry marker before the status code", async () => {
    const { fetchImpl } = stubFetch({
      status: 403,
      body: "/d2l/login?sessionExpired=1",
    });

    const result = await mint(fetchImpl);

    expect(result).toEqual({ ok: false, reason: "sessionExpired" });
  });

  it("reports a non-2xx status as a transport failure", async () => {
    const { fetchImpl } = stubFetch({ status: 403, body: "Forbidden" });

    const result = await mint(fetchImpl);

    expect(result).toEqual({
      ok: false,
      reason: "transport",
      detail: "HTTP 403",
    });
  });

  it("reports JSON without an access_token as a transport failure", async () => {
    const { fetchImpl } = stubFetch({
      status: 200,
      body: JSON.stringify({ token_type: "Bearer" }),
    });

    const result = await mint(fetchImpl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("transport");
    expect(result.detail).toBeTruthy();
  });

  it("reports unparseable JSON as a transport failure", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: "not json at all" });

    const result = await mint(fetchImpl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("transport");
  });

  it("reports a thrown fetch as a transport failure", async () => {
    const { fetchImpl } = stubFetch({ throws: new Error("ECONNRESET") });

    const result = await mint(fetchImpl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("transport");
    expect(result.detail).toContain("ECONNRESET");
  });

  it("strips a trailing slash from the base URL", async () => {
    const { fetchImpl, calls } = stubFetch({
      status: 200,
      body: JSON.stringify({ access_token: "minted-jwt" }),
    });

    await mintAccessToken({
      baseUrl: `${BASE_URL}/`,
      cookieHeader: COOKIE_HEADER,
      csrfToken: CSRF_TOKEN,
      fetchImpl,
    });

    expect(calls[0].url).toBe(`${BASE_URL}/d2l/lp/auth/oauth2/token`);
  });
});
