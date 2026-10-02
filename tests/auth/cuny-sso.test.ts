import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSSOFlow, MfaApprovalError, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import { CunySSOFlow, CUNY_TOTP_SELECTOR, isCunyBrightspace } from "../../src/auth/cuny-sso.js";
import { BrowserAuthError } from "../../src/utils/errors.js";
import type { AppConfig } from "../../src/types/index.js";

const CUNY_URL = "https://brightspace.cuny.edu";
const CREDENTIAL_URL = "https://ssologin.cuny.edu/oam/server/obrareq.cgi?encquery=abc";
const CREDENTIAL_ERROR_URL = "https://ssologin.cuny.edu/oam/server/auth_cred_submit";
const TOTP_URL = "https://ssologin.cuny.edu/oaa-totp-factor/rui/index.html?cid=1&nonce=2";
const TOTP_REJECTED_URL = "https://ssologin.cuny.edu/oaa-totp-factor/rui/index.html?cid=1&nonce=3&emsg=Entered+TOTP+is+incorrect.";
const HOME_URL = `${CUNY_URL}/d2l/home`;

type Screen = "credentials" | "credentialError" | "totp" | "home" | "blank";

interface PageState {
  url: string;
  screen: Screen;
}

/**
 * A synthetic CUNY Login page. Each state lasts one poll; the page stays on
 * the last state once the list runs out, or advances early when the flow
 * clicks something that navigates (see `onSubmit` / `onVerify`).
 */
function makeCunyPage(states: PageState[], transitions: { onSubmit?: PageState[]; onVerify?: PageState[] } = {}) {
  let queue = [...states];
  const current = () => queue[0];
  const advance = () => { if (queue.length > 1) queue.shift(); };
  const fills: Record<string, string> = {};
  const clicks: string[] = [];

  const visibleFor = (selector: string): boolean => {
    const { screen } = current();
    switch (selector) {
      case "#CUNYLoginUsernameDisplay":
      case "#CUNYLoginPassword":
      case "#submit":
        return screen === "credentials" || screen === "credentialError";
      case "#serverError":
        return screen === "credentialError";
      case CUNY_TOTP_SELECTOR:
        return screen === "totp";
      default:
        return false;
    }
  };

  const page = {
    url: vi.fn(() => current().url),
    locator: vi.fn((selector: string) => ({
      first: () => ({
        isVisible: async () => visibleFor(selector),
        fill: vi.fn(async (value: string) => { fills[selector] = value; }),
        press: vi.fn(async () => {}),
        click: vi.fn(async () => {
          clicks.push(selector);
          if (selector === "#submit" && transitions.onSubmit) queue = [...transitions.onSubmit];
        }),
      }),
    })),
    getByRole: vi.fn((_role: string, _query?: { name?: RegExp }) => ({
      first: () => ({
        isVisible: async () => current().screen === "totp",
        click: vi.fn(async () => {
          clicks.push("verify");
          if (transitions.onVerify) queue = [...transitions.onVerify];
        }),
      }),
    })),
    waitForTimeout: vi.fn(async (ms: number) => {
      vi.advanceTimersByTime(ms);
      advance();
    }),
    context: () => ({
      cookies: async () => current().screen === "home" ? [{ name: "d2lSessionVal", value: "session" }] : [],
    }),
    evaluate: vi.fn(async () => current().screen === "home"),
  };
  return { page, fills, clicks };
}

const credentials = { username: "jane.doe01@login.cuny.edu", password: "secret", baseUrl: CUNY_URL };

describe("CUNY sign-in routing", () => {
  it("routes only CUNY's exact Brightspace host to its handler", () => {
    expect(isCunyBrightspace(CUNY_URL)).toBe(true);
    expect(isCunyBrightspace("https://BRIGHTSPACE.CUNY.EDU/d2l/home")).toBe(true);
    expect(isCunyBrightspace(`${CUNY_URL}.example.org`)).toBe(false);
    expect(isCunyBrightspace("https://evil.example/?next=brightspace.cuny.edu")).toBe(false);
    expect(isCunyBrightspace("not a url")).toBe(false);
    expect(createSSOFlow({ baseUrl: CUNY_URL } as AppConfig)).toBeInstanceOf(CunySSOFlow);
  });

  it("needs both a username and a password for automatic sign-in", () => {
    expect(new CunySSOFlow(credentials).hasCredentials()).toBe(true);
    expect(new CunySSOFlow({ ...credentials, password: undefined }).hasCredentials()).toBe(false);
  });
});

describe("CUNY Login flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fills CUNY's visible username field, feeds the terminal code, and lands on Brightspace", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fills, clicks } = makeCunyPage(
      [{ url: CREDENTIAL_URL, screen: "credentials" }],
      {
        onSubmit: [{ url: CREDENTIAL_URL, screen: "blank" }, { url: TOTP_URL, screen: "totp" }],
        onVerify: [{ url: TOTP_URL, screen: "blank" }, { url: HOME_URL, screen: "home" }],
      },
    );

    await expect(new CunySSOFlow({ ...credentials, requestMfaCode }).login(page as never)).resolves.toBe(true);

    expect(fills["#CUNYLoginUsernameDisplay"]).toBe("jane.doe01@login.cuny.edu");
    expect(fills["#CUNYLoginPassword"]).toBe("secret");
    // The hidden short-name field belongs to CUNY's own submit handler.
    expect(fills["#CUNYLoginUsername"]).toBeUndefined();
    expect(fills[CUNY_TOTP_SELECTOR]).toBe("123456");
    expect(clicks).toEqual(["#submit", "verify"]);
    expect(requestMfaCode).toHaveBeenCalledOnce();
    const [role, query] = page.getByRole.mock.calls[0];
    expect(role).toBe("button");
    expect(query?.name?.test("Verify")).toBe(true);
    expect(query?.name?.test("Unverified device")).toBe(false);
  });

  it("picks up a run that hands over already on the code challenge", async () => {
    const requestMfaCode = vi.fn(async () => "654321");
    const { page, clicks } = makeCunyPage(
      [{ url: TOTP_URL, screen: "totp" }],
      { onVerify: [{ url: HOME_URL, screen: "home" }] },
    );

    await expect(new CunySSOFlow({ ...credentials, requestMfaCode }).login(page as never)).resolves.toBe(true);
    expect(clicks).toEqual(["verify"]);
  });

  it("returns without prompting when the page is already on Brightspace", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, clicks } = makeCunyPage([{ url: HOME_URL, screen: "home" }]);

    await expect(new CunySSOFlow({ ...credentials, requestMfaCode }).login(page as never)).resolves.toBe(true);
    expect(requestMfaCode).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
  });

  it("reports rejected credentials from CUNY's #serverError reload without prompting for a code", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, clicks } = makeCunyPage(
      [{ url: CREDENTIAL_URL, screen: "credentials" }],
      { onSubmit: [{ url: CREDENTIAL_ERROR_URL, screen: "credentialError" }] },
    );

    const failure = new CunySSOFlow({ ...credentials, requestMfaCode }).login(page as never);
    await expect(failure).rejects.toBeInstanceOf(BrowserAuthError);
    await expect(failure).rejects.toMatchObject({ step: "credentials" });
    await expect(failure).rejects.not.toBeInstanceOf(UnsupportedAuthenticationError);
    // One submission only: retrying a rejected password risks a lockout.
    expect(clicks).toEqual(["#submit"]);
    expect(requestMfaCode).not.toHaveBeenCalled();
  });

  it("treats the ?emsg= reload after Verify as a rejected code and asks only once", async () => {
    const requestMfaCode = vi.fn(async () => "000000");
    const { page } = makeCunyPage(
      [{ url: TOTP_URL, screen: "totp" }],
      { onVerify: [{ url: TOTP_URL, screen: "blank" }, { url: TOTP_REJECTED_URL, screen: "totp" }] },
    );

    await expect(new CunySSOFlow({ ...credentials, requestMfaCode }).login(page as never)).rejects.toBeInstanceOf(MfaApprovalError);
    expect(requestMfaCode).toHaveBeenCalledOnce();
  });

  it("does not mistake an ?emsg= left over from an earlier attempt for this code's rejection", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page } = makeCunyPage(
      [{ url: TOTP_REJECTED_URL, screen: "totp" }],
      { onVerify: [{ url: TOTP_REJECTED_URL, screen: "totp" }, { url: HOME_URL, screen: "home" }] },
    );

    await expect(new CunySSOFlow({ ...credentials, requestMfaCode }).login(page as never)).resolves.toBe(true);
  });

  it("stops with a terminal instruction when no code prompt is available", async () => {
    const { page } = makeCunyPage([{ url: TOTP_URL, screen: "totp" }]);

    const failure = new CunySSOFlow(credentials).login(page as never);
    await expect(failure).rejects.toBeInstanceOf(UnsupportedAuthenticationError);
    await expect(failure).rejects.toThrow(/authenticator code.*auth/);
  });

  it("never sends the password from a headless run that could not answer the code", async () => {
    const { page, fills, clicks } = makeCunyPage(
      [{ url: CREDENTIAL_URL, screen: "credentials" }],
      { onSubmit: [{ url: TOTP_URL, screen: "totp" }] },
    );

    await expect(new CunySSOFlow(credentials).login(page as never)).rejects.toThrow(/authenticator code.*auth/);
    expect(fills).toEqual({});
    expect(clicks).toEqual([]);
  });

  it("still fills the password for a visible browser, where the person answers the code", async () => {
    const { page, fills } = makeCunyPage(
      [{ url: CREDENTIAL_URL, screen: "credentials" }],
      { onSubmit: [{ url: TOTP_URL, screen: "totp" }, { url: HOME_URL, screen: "home" }] },
    );

    await expect(new CunySSOFlow({ ...credentials, headless: false }).login(page as never)).resolves.toBe(true);
    expect(fills["#CUNYLoginPassword"]).toBe("secret");
  });

  it("rejects a code that is not 6-8 digits before typing it", async () => {
    const { page, fills } = makeCunyPage([{ url: TOTP_URL, screen: "totp" }]);

    await expect(new CunySSOFlow({ ...credentials, requestMfaCode: async () => "12ab" }).login(page as never))
      .rejects.toThrow(/6-8 digits/);
    expect(fills[CUNY_TOTP_SELECTOR]).toBeUndefined();
  });

  it("leaves the code to the person at a visible browser and waits for Brightspace", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const onMfaChallenge = vi.fn();
    const { page, fills } = makeCunyPage([
      { url: TOTP_URL, screen: "totp" },
      { url: TOTP_URL, screen: "totp" },
      { url: HOME_URL, screen: "home" },
    ]);

    await expect(new CunySSOFlow({ ...credentials, headless: false, requestMfaCode, onMfaChallenge }).login(page as never)).resolves.toBe(true);
    expect(requestMfaCode).not.toHaveBeenCalled();
    expect(fills[CUNY_TOTP_SELECTOR]).toBeUndefined();
    expect(onMfaChallenge).toHaveBeenCalledOnce();
    expect(onMfaChallenge).toHaveBeenCalledWith(null);
  });

  it("lets the person at a visible browser retry a mistyped code", async () => {
    const onMfaChallenge = vi.fn();
    const { page } = makeCunyPage([
      { url: TOTP_URL, screen: "totp" },
      { url: TOTP_URL, screen: "blank" },
      { url: TOTP_REJECTED_URL, screen: "totp" },
      { url: TOTP_REJECTED_URL, screen: "totp" },
      { url: HOME_URL, screen: "home" },
    ]);

    await expect(new CunySSOFlow({ ...credentials, headless: false, onMfaChallenge }).login(page as never)).resolves.toBe(true);
    expect(onMfaChallenge).toHaveBeenCalledOnce();
  });

  it("presses Enter when the Verify button is not found", async () => {
    const { page, clicks } = makeCunyPage([{ url: TOTP_URL, screen: "totp" }, { url: HOME_URL, screen: "home" }]);
    page.getByRole.mockImplementation(() => ({ first: () => ({ isVisible: async () => false, click: vi.fn() }) }));

    await expect(new CunySSOFlow({ ...credentials, requestMfaCode: async () => "123456" }).login(page as never)).resolves.toBe(true);
    expect(clicks).toEqual([]);
    expect(page.locator).toHaveBeenCalledWith(CUNY_TOTP_SELECTOR);
  });

  it("never types credentials into a page that is not CUNY Login", async () => {
    for (const url of ["https://phish.example/oam/server/obrareq.cgi", "http://ssologin.cuny.edu/oamfed/idp/samlv20"]) {
      const { page, fills } = makeCunyPage([{ url, screen: "credentials" }]);

      await expect(new CunySSOFlow({ ...credentials, requestMfaCode: async () => "123456" }).login(page as never))
        .rejects.toBeInstanceOf(UnsupportedAuthenticationError);
      expect(fills).toEqual({});
    }
  });

  it("gives up with a pointer to visible-browser mode when no supported step appears", async () => {
    const { page } = makeCunyPage([{ url: "https://ssologin.cuny.edu/oaa/rui/factors", screen: "blank" }]);

    await expect(new CunySSOFlow({ ...credentials, requestMfaCode: async () => "123456" }).login(page as never))
      .rejects.toThrow(/D2L_HEADLESS=false/);
  });

  it("times out an unanswered challenge as an MFA failure", async () => {
    const { page } = makeCunyPage([{ url: TOTP_URL, screen: "totp" }]);

    await expect(new CunySSOFlow({ ...credentials, headless: false }).login(page as never))
      .rejects.toBeInstanceOf(MfaApprovalError);
  });
});
