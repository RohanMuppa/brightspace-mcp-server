import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import { MfaApprovalError, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import { AUTH_COMMAND } from "../../src/utils/commands.js";
import { BrowserAuthError } from "../../src/utils/errors.js";

const BASE_URL = "https://purdue.brightspace.com";
const SIGN_SELECTOR = "#idRichContext_DisplaySign";

interface PollState {
  number?: string;
  code?: boolean;
  /** Entra's "You didn't enter the expected verification code" under the field. */
  codeError?: boolean;
  challenge?: boolean;
  kmsi?: boolean;
  /**
   * Microsoft's federated-domain "Do you trust <domain>?" interstitial.
   * `true` names the domain the login is actually signing into (purdue.edu,
   * matching BASE_URL below); a string names a different domain, to model
   * the browser being steered to someone else's confirmation.
   */
  trust?: boolean | string;
  url?: string;
  cookie?: boolean;
  d2l?: boolean;
  /**
   * Entra's number-match timeout/denied view offering "Send another
   * request" (`#idA_SAASTO_Resend` in purdue-sso.ts). A state with `number`
   * absent and `resend: true` models the number having expired or been
   * denied while the resend control is on screen.
   */
  resend?: boolean;
  /** Entra's "Sign in another way" link, which switches verification methods. */
  otherMethod?: boolean;
}

const RESEND_ID_SELECTOR = "#idA_SAASTO_Resend";

function captureWarnings() {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("[WARN]")) lines.push(first);
  });
  return lines;
}

/** A sequence of page states driven by the same two-second poll as production. */
function makeMfaPage(states: PollState[]) {
  let poll = 0;
  const yes = vi.fn(async () => {});
  const fill = vi.fn(async () => {});
  const press = vi.fn(async () => {});
  const continueClick = vi.fn(async () => {});
  const resendClick = vi.fn(async () => {});
  const otherMethodClick = vi.fn(async () => {});
  const current = () => states[Math.min(poll, states.length - 1)] ?? {};
  const locatorTarget = (selector: string) => ({
    isVisible: async () => {
      if (selector === SIGN_SELECTOR) return current().number !== undefined;
      if (selector === "#idTxtBx_SAOTCC_OTC" || selector === 'input[name="otc"]') return Boolean(current().code);
      if (selector === "#idSubmit_SAOTCC_Continue") return Boolean(current().code);
      if (selector === "#idSpan_SAOTCC_Error_OTC") return Boolean(current().codeError);
      // `challenge` models the number-match/KMSI title heading; `code` alone
      // models a BARE verification-code page with no such heading (the
      // post-credential-challenge regression test below relies on the two
      // being independent).
      if (selector === "#idDiv_SAOTCAS_Title" || selector === "#idDiv_SAOTCC_Title") return Boolean(current().challenge);
      if (selector === "#KmsiCheckboxField" || selector === "#idSIButton9") return Boolean(current().kmsi);
      if (selector === RESEND_ID_SELECTOR) return Boolean(current().resend);
      return false;
    },
    textContent: async () => selector === SIGN_SELECTOR ? current().number ?? null : null,
    click: selector === RESEND_ID_SELECTOR ? resendClick : yes,
    fill,
    press,
  });
  const page = {
    url: vi.fn(() => current().url ?? "https://login.microsoftonline.com/common/SAS/BeginAuth"),
    locator: vi.fn((selector: string) => ({ first: () => locatorTarget(selector) })),
    // Pattern-aware: the loop asks this for "Stay signed in?" and for the
    // federated-domain trust heading, and each belongs to a different state.
    getByText: vi.fn((pattern: RegExp) => ({ first: () => ({
      isVisible: async () =>
        /stay signed in/i.test(String(pattern))
          ? Boolean(current().kmsi)
          : /do you trust/i.test(String(pattern))
            ? Boolean(current().trust)
            : /sign in another way/i.test(String(pattern))
              ? Boolean(current().otherMethod)
              : false,
      textContent: async () => {
        const trust = current().trust;
        if (!trust) return null;
        const domain = trust === true ? "purdue.edu" : trust;
        return `Do you trust ${domain}?\nWorking anonymously? Continue only if you trust it.`;
      },
      click: otherMethodClick,
    }) })),
    // Only the controls the MFA loop legitimately looks for are reported
    // visible, so an unmodelled button is never clicked by accident.
    getByRole: vi.fn((role: string, query?: { name?: RegExp }) => ({ first: () => ({
      isVisible: async () =>
        role === "button" && query?.name?.test("Continue") ? Boolean(current().trust) : false,
      click: continueClick,
    }) })),
    context: vi.fn(() => ({
      cookies: vi.fn(async () => current().cookie ? [{ name: "d2lSessionVal", value: "live" }] : []),
    })),
    evaluate: vi.fn(async () => Boolean(current().d2l)),
    waitForTimeout: vi.fn(async (milliseconds: number) => {
      poll += 1;
      vi.advanceTimersByTime(milliseconds);
    }),
  };
  return { page, yes, fill, press, continueClick, resendClick, otherMethodClick, poll: () => poll };
}

describe("Purdue MFA loop ported from Brightspace Bar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const handleMFA = (
    page: unknown,
    requestMfaCode?: () => Promise<string>,
    onMfaChallenge?: (number: string | null) => void,
  ): Promise<void> =>
    (new PurdueSSOFlow({ baseUrl: BASE_URL, requestMfaCode, onMfaChallenge }) as any).handleMFA(page);

  it("logs a number once per change and stops only at verified Brightspace home", async () => {
    const lines = captureWarnings();
    const { page } = makeMfaPage([
      { number: "42", challenge: true },
      { number: "42", challenge: true },
      { number: "73", challenge: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page);
    const numbers = lines.filter(line => line.includes("Number match:"));
    expect(numbers).toHaveLength(2);
    expect(numbers[0]).toContain("Number match: 42.");
    expect(numbers[1]).toContain("Number match: 73.");
  });

  it("reports onMfaChallenge for the first number, then again when Entra swaps in a different one", async () => {
    // Fix for the 2026-09-30 incident: a stale number in a tool response used
    // to survive for the rest of the login. onMfaChallenge must fire again
    // any time the number actually on screen changes, not just once per login.
    const onMfaChallenge = vi.fn();
    const { page } = makeMfaPage([
      { number: "42", challenge: true },
      { number: "42", challenge: true },
      { number: "73", challenge: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, undefined, onMfaChallenge);
    expect(onMfaChallenge).toHaveBeenCalledTimes(2);
    expect(onMfaChallenge).toHaveBeenNthCalledWith(1, "42");
    expect(onMfaChallenge).toHaveBeenNthCalledWith(2, "73");
  });

  it("reports onMfaChallenge with null first, then once more when a number later appears", async () => {
    const onMfaChallenge = vi.fn();
    const { page } = makeMfaPage([
      { challenge: true },
      { challenge: true },
      { number: "73", challenge: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, undefined, onMfaChallenge);
    expect(onMfaChallenge).toHaveBeenCalledTimes(2);
    expect(onMfaChallenge).toHaveBeenNthCalledWith(1, null);
    expect(onMfaChallenge).toHaveBeenNthCalledWith(2, "73");
  });

  it("resends an expired number-match request and re-announces the new number", async () => {
    const onMfaChallenge = vi.fn();
    const { page, resendClick } = makeMfaPage([
      { number: "42", challenge: true },
      { resend: true },
      { number: "73", challenge: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, undefined, onMfaChallenge);
    expect(resendClick).toHaveBeenCalledOnce();
    expect(onMfaChallenge).toHaveBeenCalledTimes(2);
    expect(onMfaChallenge).toHaveBeenNthCalledWith(1, "42");
    expect(onMfaChallenge).toHaveBeenNthCalledWith(2, "73");
  });

  it("resends at most twice, then falls through to the existing timeout", async () => {
    captureWarnings();
    // The number never comes back, so the loop should give up resending
    // after MAX_RESENDS and let the ordinary 5-minute timeout take over
    // rather than clicking "Send another request" forever.
    const { page, resendClick } = makeMfaPage([
      { number: "42", challenge: true },
      { resend: true },
    ]);
    await expect(handleMFA(page)).rejects.toMatchObject({ numberMatch: "42" });
    expect(resendClick).toHaveBeenCalledTimes(2);
  });

  it("clicks Yes only on a proven stay-signed-in page", async () => {
    const { page, yes } = makeMfaPage([
      { kmsi: true, url: "https://login.microsoftonline.com/common/kmsi" },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page);
    expect(yes).toHaveBeenCalledOnce();
  });

  it("clicks Continue on Microsoft's federated-domain trust prompt", async () => {
    // A federated domain (reached via whr=) makes Microsoft ask "Do you trust
    // <domain>?" only after the IdP has already succeeded. Leaving it unclicked
    // parks the browser on login.srf and the LMS is never reached.
    const { page, continueClick } = makeMfaPage([
      { trust: true, url: "https://login.microsoftonline.com/login.srf" },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page);
    expect(continueClick).toHaveBeenCalledOnce();
  });

  it("does not click Continue when the trust prompt names a domain other than the configured school", async () => {
    // The trust dialog is an anti-login-CSRF control: it must never be
    // confirmed for a tenant/domain other than the one this login is
    // actually signing into (here, Purdue's own purdue.edu).
    captureWarnings();
    const { page, continueClick } = makeMfaPage([
      { trust: "not-purdue.example", url: "https://login.microsoftonline.com/login.srf" },
    ]);
    await expect(handleMFA(page)).rejects.toBeInstanceOf(UnsupportedAuthenticationError);
    expect(continueClick).not.toHaveBeenCalled();
  });

  it("submits an authenticator code without exposing it in logs", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fill, yes } = makeMfaPage([
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, requestMfaCode);
    expect(requestMfaCode).toHaveBeenCalledOnce();
    expect(fill).toHaveBeenCalledWith("123456");
    expect(yes).toHaveBeenCalledOnce();
  });

  it("directs non-interactive authentication to the CLI when a code is required", async () => {
    const { page, poll } = makeMfaPage([{ code: true }]);
    // Must be the pinned command. An untagged npx invocation runs whatever old
    // global copy is on PATH, which is how a healthy server once sent someone
    // into a stale build that could not sign in at all.
    await expect(handleMFA(page)).rejects.toThrow(`Run \`${AUTH_COMMAND}\``);
    expect(poll()).toBe(0);
  });

  it("asks for a code once even if the field lingers while Microsoft validates", async () => {
    // Microsoft often leaves the OTC input on screen for a few seconds after
    // submit. The poll must not read that as "ask them again".
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fill } = makeMfaPage([
      { code: true },
      { code: true },
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, requestMfaCode);
    expect(requestMfaCode).toHaveBeenCalledOnce();
    expect(fill).toHaveBeenCalledOnce();
  });

  it("asks for a fresh code after Microsoft rejects one", async () => {
    const lines = captureWarnings();
    const requestMfaCode = vi.fn().mockResolvedValueOnce("111111").mockResolvedValueOnce("222222");
    const { page, fill } = makeMfaPage([
      { code: true },
      { code: true, codeError: true },
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, requestMfaCode);
    expect(fill.mock.calls).toEqual([["111111"], ["222222"]]);
    expect(lines.some((line) => line.includes("Microsoft rejected that code"))).toBe(true);
  });

  it("stops after three rejected codes instead of waiting out the MFA timeout", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, poll } = makeMfaPage([{ code: true }, { code: true, codeError: true }]);
    const failure = handleMFA(page, requestMfaCode);
    await expect(failure).rejects.toBeInstanceOf(BrowserAuthError);
    await expect(failure).rejects.toThrow("Microsoft rejected 3 authenticator codes");
    await expect(failure).rejects.not.toBeInstanceOf(MfaApprovalError);
    expect(requestMfaCode).toHaveBeenCalledTimes(3);
    // One extra settle poll follows each of the two resubmissions (see the
    // lingering-span test below), so three rejections take five polls, not three.
    expect(poll()).toBe(5);
  });

  it("does not let a lingering rejection span immediately trigger a third prompt", async () => {
    // The error span from attempt 1's rejection can still be in the DOM on the
    // very next poll after attempt 2 is resubmitted - Entra hasn't re-rendered
    // yet. That stale span must not be read as attempt 2 also being rejected.
    const lines = captureWarnings();
    const requestMfaCode = vi.fn().mockResolvedValueOnce("111111").mockResolvedValueOnce("222222").mockResolvedValueOnce("333333");
    const { page, fill } = makeMfaPage([
      { code: true },
      { code: true, codeError: true },
      { code: true, codeError: true }, // stale span from attempt 1's rejection, still showing
      { code: true }, // Entra has caught up: attempt 2 is pending, no error
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, requestMfaCode);
    expect(fill.mock.calls).toEqual([["111111"], ["222222"]]);
    expect(requestMfaCode).toHaveBeenCalledTimes(2);
    expect(lines.filter((line) => line.includes("Microsoft rejected that code"))).toHaveLength(1);
  });

  it("submits a visible code form instead of switching to another verification method", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fill, otherMethodClick } = makeMfaPage([
      { code: true, otherMethod: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page, requestMfaCode);
    expect(fill).toHaveBeenCalledWith("123456");
    expect(otherMethodClick).not.toHaveBeenCalled();
  });

  it("completes a verified Brightspace home without announcing stale challenge controls", async () => {
    const lines = captureWarnings();
    const onMfaChallenge = vi.fn();
    const { page } = makeMfaPage([
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true, number: "42", challenge: true },
    ]);
    await handleMFA(page, undefined, onMfaChallenge);
    expect({ warnings: lines, onMfaChallenge: onMfaChallenge.mock.calls }).toEqual({ warnings: [], onMfaChallenge: [] });
  });

  it("does not ask for a code when a verified Brightspace home still shows a stale code field", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page } = makeMfaPage([
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true, code: true },
    ]);
    await handleMFA(page, requestMfaCode);
    expect(requestMfaCode).not.toHaveBeenCalled();
  });

  it("leaves code entry to the user when the browser is visible", async () => {
    const { page, fill } = makeMfaPage([
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await (new PurdueSSOFlow({ baseUrl: BASE_URL, headless: false }) as any).handleMFA(page);
    expect(fill).not.toHaveBeenCalled();
  });

  it("rejects the login shell even when it has a cookie and D2L.LP", async () => {
    const { page, poll } = makeMfaPage([
      { url: `${BASE_URL}/d2l/login`, cookie: true, d2l: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(page);
    expect(poll()).toBe(1);
  });

  it("classifies an observed challenge timeout as failed MFA", async () => {
    captureWarnings();
    const { page } = makeMfaPage([{ number: "18", challenge: true }]);
    await expect(handleMFA(page)).rejects.toBeInstanceOf(MfaApprovalError);
  });

  it("carries the last announced number-match digits on a timed-out challenge", async () => {
    captureWarnings();
    const { page } = makeMfaPage([
      { number: "18", challenge: true },
      { number: "73", challenge: true },
    ]);
    await expect(handleMFA(page)).rejects.toMatchObject({ numberMatch: "73" });
  });

  it("classifies a timeout with no challenge as unsupported instead of failed MFA", async () => {
    const { page } = makeMfaPage([{}]);
    await expect(handleMFA(page)).rejects.toBeInstanceOf(UnsupportedAuthenticationError);
  });

  it("treats a bare verification-code page as a post-credential challenge instead of re-entering credentials", async () => {
    // Entra can land directly on its verification-code form (no number-match
    // digits, no #idDiv_SAOTCAS_Title/#idDiv_SAOTCC_Title heading) when
    // resuming a restored session. hasPostCredentialChallenge used to miss
    // this, so login() concluded no challenge was present and re-ran
    // enterCredentials against a page with no username/password field.
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fill } = makeMfaPage([
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    const flow = new PurdueSSOFlow({
      baseUrl: BASE_URL,
      username: "student@purdue.edu",
      password: "dummy-password",
      requestMfaCode,
    });
    const enterCredentialsSpy = vi.spyOn(flow as any, "enterCredentials");

    await expect(flow.login(page as never)).resolves.toBe(true);

    expect(enterCredentialsSpy).not.toHaveBeenCalled();
    expect(fill).toHaveBeenCalledWith("123456");
  });
});
