import { describe, it, expect } from "vitest";
import { fetchXsrfToken, parseXsrfToken } from "../../src/auth/xsrf-fetch.js";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(
  answer: { status: number; body: string; location?: string } | { throws: Error }
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if ("throws" in answer) throw answer.throws;
    return {
      status: answer.status,
      text: async () => answer.body,
      headers: new Headers(answer.location ? { location: answer.location } : {}),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const BASE_URL = "https://purdue.brightspace.com";
const COOKIE_HEADER = "d2lSessionVal=aaa; d2lSecureSessionVal=bbb";
const XSRF = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

const fetchWith = (fetchImpl: typeof fetch) => fetchXsrfToken({ baseUrl: BASE_URL, cookieHeader: COOKIE_HEADER, fetchImpl });

describe("parseXsrfToken", () => {
  it("reads the inline localStorage write", () => {
    expect(parseXsrfToken(`<script>localStorage.setItem('XSRF.Token','${XSRF}');</script>`)).toBe(XSRF);
    expect(parseXsrfToken(`localStorage.setItem("XSRF.Token", "${XSRF}")`)).toBe(XSRF);
  });

  it("reads the write when it sits inside a JSON-escaped string", () => {
    expect(parseXsrfToken(`"localStorage.setItem(\\"XSRF.Token\\",\\"${XSRF}\\")"`)).toBe(XSRF);
  });

  it("reads the meta tag in either attribute order", () => {
    expect(parseXsrfToken(`<meta name="d2l-xsrf-token" content="${XSRF}">`)).toBe(XSRF);
    expect(parseXsrfToken(`<meta content="${XSRF}" name="d2l-xsrf-token">`)).toBe(XSRF);
  });

  it("ignores the hit code seed and pages without a token", () => {
    expect(parseXsrfToken(`localStorage.setItem('XSRF.HitCodeSeed','7')`)).toBeNull();
    expect(parseXsrfToken("<html><body>Home</body></html>")).toBeNull();
  });
});

describe("fetchXsrfToken", () => {
  it("GETs /d2l/home with the cookie and no redirect following", async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: `localStorage.setItem('XSRF.Token','${XSRF}')` });

    const result = await fetchWith(fetchImpl);

    expect(result).toEqual({ ok: true, csrfToken: XSRF });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE_URL}/d2l/home`);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.redirect).toBe("manual");
    expect((calls[0].init.headers as Record<string, string>).cookie).toBe(COOKIE_HEADER);
  });

  it("reports the 200 session-expired stub as an expired session", async () => {
    const { fetchImpl } = stubFetch({
      status: 200,
      body: `<script>window.location.replace('/d2l/login?sessionExpired=1&target=%2fd2l%2fhome');</script>`,
    });

    expect(await fetchWith(fetchImpl)).toEqual({ ok: false, reason: "sessionExpired" });
  });

  it("reports a redirect to the login page as an expired session", async () => {
    const { fetchImpl } = stubFetch({ status: 302, body: "", location: "/d2l/login?target=%2fd2l%2fhome" });

    expect(await fetchWith(fetchImpl)).toEqual({ ok: false, reason: "sessionExpired" });
  });

  it("reports a signed-in page without a token as notFound", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: "<html><body>My Home</body></html>" });

    expect(await fetchWith(fetchImpl)).toEqual({ ok: false, reason: "notFound" });
  });

  it("reports server errors and network failures as transport", async () => {
    expect(await fetchWith(stubFetch({ status: 503, body: "" }).fetchImpl)).toMatchObject({ ok: false, reason: "transport" });
    expect(await fetchWith(stubFetch({ throws: new Error("ECONNRESET") }).fetchImpl)).toEqual({
      ok: false,
      reason: "transport",
      detail: "ECONNRESET",
    });
  });
});
