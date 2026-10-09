import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import { AutomaticCodeAuthenticationError, MfaApprovalError, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import { generateTotp } from "../../src/auth/totp.js";

/**
 * Automatic verification-code sign-in: with a saved authenticator enrollment,
 * the Entra MFA loop switches to Microsoft's code form and types a code it
 * generates locally instead of waiting on a phone approval.
 * Ported from ElliotDrel/brightspace-mcp-server (branch codex/purdue-totp, PR
 * #54) and adapted — see the fallback, passwordless and Duo cases below, which
 * his branch predates.
 *
 * With NO enrollment saved, every one of these paths is inert: that is what
 * the last describe block pins, and the rest of tests/auth/purdue-sso-mfa.test.ts
 * covers the unchanged behavior in full.
 */

const BASE_URL = "https://purdue.brightspace.com";
const URI = "otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SIGN_SELECTOR = "#idRichContext_DisplaySign";
const APPROVAL_SIGN_SELECTOR = "#idRemoteNGC_DisplaySign";
const PASSWORD_SWITCH = "#idA_PWD_SwitchToPassword";
const ACCOUNT_SELECTORS = ["#displayName", "#signInName", "#userDisplayName"];

interface PollState {
  number?: string;
  code?: boolean;
  /** Entra's "You didn't enter the expected verification code" under the field. */
  codeError?: boolean;
  /** Entra's exact "Use a verification code" control. */
  codeMethod?: boolean;
  /** Entra's vaguer "Sign in another way" link, which only opens the method list. */
  otherMethod?: boolean;
  /** The account Microsoft says is signing in, shown in #displayName. */
  account?: string;
  challenge?: boolean;
  kmsi?: boolean;
  /** Microsoft's passwordless phone-approval view and its number. */
  approval?: string;
  /** A visible password field (and the submit button beneath it). */
  password?: boolean;
  url?: string;
  cookie?: boolean;
  d2l?: boolean;
}

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
  const press = vi.fn(async () => {});
  const continueClick = vi.fn(async () => {});
  const methodClick = vi.fn(async () => {});
  /** Every code submitted, with the clock reading when it was typed. */
  const fills: { value: string; at: number }[] = [];
  const fill = vi.fn(async (value: string) => { fills.push({ value, at: Date.now() }); });
  /** Every waitForTimeout duration, so the fresh-code pacing is observable. */
  const waits: number[] = [];
  const current = () => states[Math.min(poll, states.length - 1)] ?? {};
  const locatorTarget = (selector: string) => ({
    // Only #displayName is modelled, so the other two layouts stand in for the
    // absent-control case the production guard exists for.
    count: async () => (selector === "#displayName" && current().account ? 1 : 0),
    isVisible: async () => {
      if (selector === SIGN_SELECTOR) return current().number !== undefined;
      if (selector === "#idTxtBx_SAOTCC_OTC" || selector === 'input[name="otc"]') return Boolean(current().code);
      if (selector === "#idSubmit_SAOTCC_Continue") return Boolean(current().code);
      if (selector === "#idSpan_SAOTCC_Error_OTC") return Boolean(current().codeError);
      if (selector === "#idDiv_SAOTCAS_Title" || selector === "#idDiv_SAOTCC_Title") {
        return Boolean(current().challenge || current().code);
      }
      if (selector === "input[type=password]" || selector === "input[name=passwd]") return Boolean(current().password);
      if (selector === "#idSIButton9") return Boolean(current().kmsi || current().password);
      if (selector === "#KmsiCheckboxField") return Boolean(current().kmsi);
      if (selector === APPROVAL_SIGN_SELECTOR || selector === PASSWORD_SWITCH) return current().approval !== undefined;
      return false;
    },
    textContent: async () => {
      // Production must never await an account label it has not counted first:
      // textContent() auto-waits a missing element out for 30 s per MFA poll.
      if (ACCOUNT_SELECTORS.includes(selector) && !(selector === "#displayName" && current().account)) {
        throw new Error("Optional account labels must not be awaited when absent");
      }
      return selector === SIGN_SELECTOR ? current().number ?? null
        : selector === APPROVAL_SIGN_SELECTOR ? current().approval ?? null
          : selector === "#displayName" ? current().account ?? null : null;
    },
    click: yes,
    fill,
    press,
  });
  const page = {
    url: vi.fn(() => current().url ?? "https://login.microsoftonline.com/common/SAS/BeginAuth"),
    locator: vi.fn((selector: string) => ({ first: () => locatorTarget(selector) })),
    getByText: vi.fn((pattern: RegExp) => {
      const source = String(pattern);
      const visible = /stay signed in/i.test(source) ? () => Boolean(current().kmsi)
        : /use a verification code/i.test(source) ? () => Boolean(current().codeMethod)
          : /sign in another way/i.test(source) ? () => Boolean(current().otherMethod)
            : /do you trust/i.test(source) ? () => false
              : () => false;
      const isMethod = /verification code|sign in another way/i.test(source);
      return { first: () => ({
        isVisible: async () => visible(),
        textContent: async () => null,
        click: isMethod ? methodClick : continueClick,
      }) };
    }),
    getByRole: vi.fn(() => ({ first: () => ({ isVisible: async () => false, click: continueClick }) })),
    context: vi.fn(() => ({
      cookies: vi.fn(async () => (current().cookie ? [{ name: "d2lSessionVal", value: "live" }] : [])),
    })),
    evaluate: vi.fn(async () => Boolean(current().d2l)),
    waitForTimeout: vi.fn(async (milliseconds: number) => {
      waits.push(milliseconds);
      poll += 1;
      vi.advanceTimersByTime(milliseconds);
    }),
  };
  return { page, fills, waits, methodClick, poll: () => poll };
}

interface FlowOptions {
  totpUri?: string;
  onMfaChallenge?: (number: string | null) => void;
  onAutomaticPending?: () => void;
  requestMfaCode?: () => Promise<string>;
}

function flowFor(options: FlowOptions = {}) {
  return new PurdueSSOFlow({ baseUrl: BASE_URL, username: "alice", ...options });
}

const handleMFA = (flow: PurdueSSOFlow, page: unknown): Promise<void> => (flow as any).handleMFA(page);

describe("automatic verification-code sign-in from a saved enrollment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A whole minute, so the code on screen has its full period left and the
    // first submission is never delayed by the fresh-code guard.
    vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("selects Microsoft's code method and answers it with a locally generated code", async () => {
    const { page, fills, methodClick } = makeMfaPage([
      { codeMethod: true },
      { code: true, account: "alice@purdue.edu" },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(flowFor({ totpUri: URI }), page);
    expect(methodClick).toHaveBeenCalledOnce();
    expect(fills).toHaveLength(1);
    expect(fills[0].value).toBe(generateTotp(URI, fills[0].at));
  });

  it("opens the alternate-method list before choosing the verification code", async () => {
    const { page, fills, methodClick } = makeMfaPage([
      { otherMethod: true },
      { codeMethod: true },
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(flowFor({ totpUri: URI }), page);
    expect(methodClick).toHaveBeenCalledTimes(2);
    expect(fills).toHaveLength(1);
  });

  it("clicks each method control at most once, then gives way to the approval path", async () => {
    // Both controls stay on screen forever: without the per-login guard this
    // loop would click them for the whole five-minute budget. Once both are
    // spent and no code form ever appeared, the fallback below takes over.
    const onMfaChallenge = vi.fn();
    const { page, methodClick } = makeMfaPage([{ codeMethod: true, otherMethod: true, challenge: true }]);
    await expect(handleMFA(flowFor({ totpUri: URI, onMfaChallenge }), page)).rejects.toBeInstanceOf(MfaApprovalError);
    expect(methodClick).toHaveBeenCalledTimes(2);
    expect(onMfaChallenge).toHaveBeenCalledWith(null);
  });

  it("never tells the user to approve a phone prompt while it is typing the code itself", async () => {
    const onMfaChallenge = vi.fn();
    const { page, fills } = makeMfaPage([
      { number: "42", challenge: true },
      { number: "42", challenge: true },
      { otherMethod: true, number: "42", challenge: true },
      { codeMethod: true },
      { code: true, number: "42" },
      { number: "42", challenge: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(flowFor({ totpUri: URI, onMfaChallenge }), page);
    expect(fills).toHaveLength(1);
    expect(onMfaChallenge).not.toHaveBeenCalled();
  });

  it("stays automatic when the code method only appears half a minute in", async () => {
    const onMfaChallenge = vi.fn();
    const onAutomaticPending = vi.fn();
    const { page, fills } = makeMfaPage([
      ...Array.from({ length: 12 }, () => ({ number: "42", challenge: true })),
      { otherMethod: true }, { codeMethod: true }, { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(flowFor({ totpUri: URI, onMfaChallenge, onAutomaticPending }), page);
    expect(fills).toHaveLength(1);
    expect(onMfaChallenge).not.toHaveBeenCalled();
    // Reported as progress, not as a challenge: nothing was asked of the user.
    expect(onAutomaticPending).toHaveBeenCalledOnce();
  });

  it("answers a code form that is already on screen instead of switching methods", async () => {
    const { page, fills, methodClick } = makeMfaPage([
      { code: true, otherMethod: true },
      { code: true, otherMethod: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(flowFor({ totpUri: URI }), page);
    expect(fills).toHaveLength(1);
    expect(methodClick).not.toHaveBeenCalled();
  });

  it("waits out the rest of the period before retrying a rejected code", async () => {
    const { page, fills, waits } = makeMfaPage([
      { code: true },
      { code: true, codeError: true },
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(flowFor({ totpUri: URI }), page);
    expect(fills).toHaveLength(2);
    // The second code is the NEXT period's, not the rejected one resubmitted.
    expect(fills[1].value).not.toBe(fills[0].value);
    expect(fills[1].value).toBe(generateTotp(URI, fills[1].at));
    expect(waits.some((wait) => wait > 2000)).toBe(true);
  });

  it("reports an unfinished automatic sign-in as its own failure, not a missed approval", async () => {
    const onMfaChallenge = vi.fn();
    const onAutomaticPending = vi.fn();
    const { page, fills } = makeMfaPage([{ code: true }]);
    await expect(handleMFA(flowFor({ totpUri: URI, onMfaChallenge, onAutomaticPending }), page))
      .rejects.toBeInstanceOf(AutomaticCodeAuthenticationError);
    expect(fills).toHaveLength(1);
    expect(onMfaChallenge).not.toHaveBeenCalled();
    expect(onAutomaticPending).toHaveBeenCalledOnce();
  });

  it("refuses to type a code when Microsoft is showing another account", async () => {
    const { page, fills } = makeMfaPage([{ code: true, account: "other@purdue.edu" }]);
    await expect(handleMFA(flowFor({ totpUri: URI }), page))
      .rejects.toThrow("Microsoft is showing another account");
    expect(fills).toHaveLength(0);
  });
});

describe("automatic code sign-in giving way to the approval path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("falls back to announcing the approval when Entra offers no code method", async () => {
    // A tenant can show a challenge with no way to type a code at all. The
    // alternative to this fallback is polling a page nothing will ever click
    // for the full five minutes and then blaming automatic code entry.
    const lines = captureWarnings();
    const onMfaChallenge = vi.fn();
    const { page, fills, methodClick } = makeMfaPage([{ number: "42", challenge: true }]);
    await expect(handleMFA(flowFor({ totpUri: URI, onMfaChallenge }), page))
      .rejects.toBeInstanceOf(MfaApprovalError);
    expect(methodClick).not.toHaveBeenCalled();
    expect(fills).toHaveLength(0);
    expect(onMfaChallenge).toHaveBeenCalledWith("42");
    expect(lines.some((line) => line.includes("no way to enter a verification code"))).toBe(true);
  });

  it("leaves Microsoft's passwordless approval view to the phone", async () => {
    // Passwordless sign-in (#206) makes the phone the FIRST factor; a
    // verification code cannot stand in for it, so this challenge is announced
    // exactly as it is without an enrollment saved.
    const onMfaChallenge = vi.fn();
    const onAutomaticPending = vi.fn();
    const { page, fills, methodClick } = makeMfaPage([{ approval: "71", codeMethod: true }]);
    await expect(handleMFA(flowFor({ totpUri: URI, passwordless: true, onMfaChallenge, onAutomaticPending } as FlowOptions), page))
      .rejects.toBeInstanceOf(MfaApprovalError);
    expect(onMfaChallenge).toHaveBeenCalledWith("71");
    expect(methodClick).not.toHaveBeenCalled();
    expect(fills).toHaveLength(0);
    expect(onAutomaticPending).not.toHaveBeenCalled();
  });

  it("takes 'Use your password instead' on the approval view when a password is saved, then answers the code", async () => {
    // Live on Purdue (2026-10-09): with phone sign-in on, Entra answers the
    // username with the approval view. A code cannot stand in for the phone
    // there, but after the password Entra asks for a second factor it can.
    const onMfaChallenge = vi.fn();
    const { page, fills } = makeMfaPage([
      { approval: "65", password: true },
      { otherMethod: true, number: "65" },
      { codeMethod: true },
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(flowFor({ totpUri: URI, password: "pw", onMfaChallenge } as FlowOptions), page);
    expect(fills[0].value).toBe("pw");
    expect(fills).toHaveLength(2);
    expect(fills[1].value).toBe(generateTotp(URI, fills[1].at));
    expect(onMfaChallenge).not.toHaveBeenCalled();
  });

  it("leaves the approval view to the phone when no enrollment is saved, password or not", async () => {
    const onMfaChallenge = vi.fn();
    const { page, fills } = makeMfaPage([{ approval: "71", password: true }]);
    await expect(handleMFA(flowFor({ password: "pw", onMfaChallenge } as FlowOptions), page))
      .rejects.toBeInstanceOf(MfaApprovalError);
    expect(fills).toHaveLength(0);
    expect(onMfaChallenge).toHaveBeenCalledWith("71");
  });

  it("leaves a Duo challenge alone: its codes come from a different enrollment", async () => {
    const flow = flowFor({ totpUri: URI });
    const handle = vi.spyOn((flow as any).duoMfa, "handle")
      .mockResolvedValueOnce(true as never)
      .mockResolvedValue(false as never);
    const { page, fills, methodClick } = makeMfaPage([{ codeMethod: true, challenge: true }]);
    await expect(handleMFA(flow, page)).rejects.toBeInstanceOf(MfaApprovalError);
    expect(handle).toHaveBeenCalled();
    expect(methodClick).not.toHaveBeenCalled();
    expect(fills).toHaveLength(0);
  });
});

describe("no saved enrollment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("never touches a method control and announces the challenge as before", async () => {
    const onMfaChallenge = vi.fn();
    const onAutomaticPending = vi.fn();
    const { page, fills, methodClick } = makeMfaPage([{ number: "42", challenge: true, codeMethod: true, otherMethod: true }]);
    await expect(handleMFA(flowFor({ onMfaChallenge, onAutomaticPending }), page))
      .rejects.toBeInstanceOf(MfaApprovalError);
    expect(methodClick).not.toHaveBeenCalled();
    expect(fills).toHaveLength(0);
    expect(onMfaChallenge).toHaveBeenCalledWith("42");
    expect(onAutomaticPending).not.toHaveBeenCalled();
  });

  it("still routes a bare code form to the terminal prompt", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fills } = makeMfaPage([
      { code: true },
      { url: `${BASE_URL}/d2l/home`, cookie: true, d2l: true },
    ]);
    await handleMFA(flowFor({ requestMfaCode }), page);
    expect(requestMfaCode).toHaveBeenCalledOnce();
    expect(fills.map((entry) => entry.value)).toEqual(["123456"]);
  });

  it("reports an unsupported login rather than an automatic-code failure", async () => {
    const { page } = makeMfaPage([{ url: "https://login.microsoftonline.com/common/login" }]);
    const error = await handleMFA(flowFor({}), page).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedAuthenticationError);
    expect(error).not.toBeInstanceOf(AutomaticCodeAuthenticationError);
  });
});
