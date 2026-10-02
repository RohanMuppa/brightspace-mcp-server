import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSSOFlow, MfaApprovalError, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import { JaverianaSSOFlow, isJaverianaBrightspace } from "../../src/auth/javeriana-sso.js";
import { BrowserAuthError } from "../../src/utils/errors.js";
import type { AppConfig } from "../../src/types/index.js";

const JAVERIANA_URL = "https://auladigital.javerianacali.edu.co";
const ONEGATE = "https://mg-local.servicios.javerianacali.edu.co";
const CHOOSER_URL = `${ONEGATE}/samlv2/idp/sign_in/42`;
const CREDENTIALS_URL = `${ONEGATE}/mg-local/login?type=webtoken`;
const TOKEN_URL = `${ONEGATE}/auth/totp/verify`;
const TOKEN_RELOADED_URL = `${ONEGATE}/auth/totp/verify?r=2`;
const HOME_URL = `${JAVERIANA_URL}/d2l/home`;
/** Same path shape as the real IdP, but a different, untrusted host. */
const LOOKALIKE_CREDENTIALS_URL = "https://mg-local.servicios.javerianacali.edu.co.evil.example/mg-local/login?type=webtoken";

const SELECTORS = {
  username: "input#user-id",
  password: "input#password",
  token: "input#token",
  credentialsSubmit: 'form#form input[type="submit"]',
  tokenSubmit: 'form#otp-form input[type="submit"]',
  chooserLink: 'a[href*="type=webtoken"]',
  statusMessage: ".box--system-message",
} as const;

type Screen = "chooser" | "credentials" | "credentials-error" | "token" | "home" | "blank";

interface PageState {
  url: string;
  screen: Screen;
}

/**
 * A synthetic OneGate page. Each state lasts until a click/goto replaces the
 * queue wholesale (mirroring a real navigation), or `waitForTimeout` (the
 * flow's poll) advances to the next queued state.
 */
function makeJaverianaPage(
  states: PageState[],
  transitions: { onGoto?: PageState[]; onSubmitCredentials?: PageState[]; onSubmitCode?: PageState[] } = {},
) {
  let queue = [...states];
  const current = () => queue[0];
  const advance = () => { if (queue.length > 1) queue.shift(); };
  const fills: Record<string, string> = {};
  const clicks: string[] = [];

  const countFor = (selector: string): number => {
    const { screen } = current();
    if (selector === SELECTORS.username) return screen === "credentials" || screen === "credentials-error" ? 1 : 0;
    if (selector === SELECTORS.token) return screen === "token" ? 1 : 0;
    if (selector === SELECTORS.chooserLink) return screen === "chooser" ? 1 : 0;
    return 0;
  };

  const visibleFor = (selector: string): boolean => {
    const { screen } = current();
    switch (selector) {
      case SELECTORS.username:
      case SELECTORS.password:
      case SELECTORS.credentialsSubmit:
        return screen === "credentials" || screen === "credentials-error";
      case SELECTORS.token:
      case SELECTORS.tokenSubmit:
        return screen === "token";
      case SELECTORS.statusMessage:
        return screen === "credentials-error";
      default:
        return false;
    }
  };

  const editableFor = (selector: string): boolean => selector === SELECTORS.token && current().screen === "token";

  const page = {
    url: vi.fn(() => current().url),
    goto: vi.fn(async () => {
      if (transitions.onGoto) queue = [...transitions.onGoto];
    }),
    waitForLoadState: vi.fn(async () => {}),
    locator: vi.fn((selector: string) => ({
      count: vi.fn(async () => countFor(selector)),
      first: () => ({
        isVisible: async () => visibleFor(selector),
        isEditable: async () => editableFor(selector),
        fill: vi.fn(async (value: string) => { fills[selector] = value; }),
        click: vi.fn(async () => {
          clicks.push(selector);
          if (selector === SELECTORS.credentialsSubmit && transitions.onSubmitCredentials) {
            queue = [...transitions.onSubmitCredentials];
          }
          if (selector === SELECTORS.tokenSubmit && transitions.onSubmitCode) {
            queue = [...transitions.onSubmitCode];
          }
        }),
        textContent: async () => current().screen === "credentials-error" ? "Usuario o contraseña incorrectos." : null,
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

const credentials = { username: "jstudent", password: "secret", baseUrl: JAVERIANA_URL };

describe("Javeriana Cali sign-in routing", () => {
  it("routes only Javeriana Cali's exact Brightspace host to its handler", () => {
    expect(isJaverianaBrightspace(JAVERIANA_URL)).toBe(true);
    expect(isJaverianaBrightspace("https://AULADIGITAL.JAVERIANACALI.EDU.CO/d2l/home")).toBe(true);
    expect(isJaverianaBrightspace(`${JAVERIANA_URL}.example.org`)).toBe(false);
    expect(isJaverianaBrightspace("https://evil.example/?next=auladigital.javerianacali.edu.co")).toBe(false);
    expect(isJaverianaBrightspace("not a url")).toBe(false);
    expect(createSSOFlow({ baseUrl: JAVERIANA_URL } as AppConfig)).toBeInstanceOf(JaverianaSSOFlow);
  });

  it("needs both a username and a password for automatic sign-in", () => {
    expect(new JaverianaSSOFlow(credentials).hasCredentials()).toBe(true);
    expect(new JaverianaSSOFlow({ ...credentials, password: undefined }).hasCredentials()).toBe(false);
  });
});

describe("Javeriana Cali / OneGate login flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("follows the chooser to the password form, enters the terminal code, and lands on Brightspace", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, fills, clicks } = makeJaverianaPage(
      [{ url: CHOOSER_URL, screen: "chooser" }],
      {
        onGoto: [{ url: CREDENTIALS_URL, screen: "credentials" }],
        onSubmitCredentials: [{ url: CREDENTIALS_URL, screen: "blank" }, { url: TOKEN_URL, screen: "token" }],
        onSubmitCode: [{ url: TOKEN_URL, screen: "blank" }, { url: HOME_URL, screen: "home" }],
      },
    );

    await expect(new JaverianaSSOFlow({ ...credentials, requestMfaCode }).login(page as never)).resolves.toBe(true);

    expect(page.goto).toHaveBeenCalledWith(`${ONEGATE}/mg-local/login?type=webtoken`, expect.objectContaining({ waitUntil: "load" }));
    expect(fills[SELECTORS.username]).toBe("jstudent");
    expect(fills[SELECTORS.password]).toBe("secret");
    expect(fills[SELECTORS.token]).toBe("123456");
    expect(clicks).toEqual([SELECTORS.credentialsSubmit, SELECTORS.tokenSubmit]);
    expect(requestMfaCode).toHaveBeenCalledOnce();
  });

  it("picks up a run that hands over already on the code challenge", async () => {
    const requestMfaCode = vi.fn(async () => "654321");
    const { page, clicks, fills } = makeJaverianaPage(
      [{ url: TOKEN_URL, screen: "token" }],
      { onSubmitCode: [{ url: TOKEN_URL, screen: "blank" }, { url: HOME_URL, screen: "home" }] },
    );

    await expect(new JaverianaSSOFlow({ ...credentials, requestMfaCode }).login(page as never)).resolves.toBe(true);
    expect(clicks).toEqual([SELECTORS.tokenSubmit]);
    expect(fills[SELECTORS.username]).toBeUndefined();
  });

  it("returns without prompting when the page is already on Brightspace", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    const { page, clicks } = makeJaverianaPage([{ url: HOME_URL, screen: "home" }]);

    await expect(new JaverianaSSOFlow({ ...credentials, requestMfaCode }).login(page as never)).resolves.toBe(true);
    expect(requestMfaCode).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
  });

  it("treats a reload of the code challenge after submit as a rejected code", async () => {
    const requestMfaCode = vi.fn(async () => "000000");
    const { page } = makeJaverianaPage(
      [{ url: TOKEN_URL, screen: "token" }],
      { onSubmitCode: [{ url: TOKEN_URL, screen: "token" }, { url: TOKEN_RELOADED_URL, screen: "token" }] },
    );

    await expect(new JaverianaSSOFlow({ ...credentials, requestMfaCode }).login(page as never)).rejects.toBeInstanceOf(MfaApprovalError);
    expect(requestMfaCode).toHaveBeenCalledOnce();
  });

  it("stops with a terminal instruction when no code prompt is available", async () => {
    const { page } = makeJaverianaPage([{ url: TOKEN_URL, screen: "token" }]);

    const failure = new JaverianaSSOFlow(credentials).login(page as never);
    await expect(failure).rejects.toBeInstanceOf(UnsupportedAuthenticationError);
    await expect(failure).rejects.toThrow(/authenticator code.*auth/);
  });

  it("never sends the password from a headless run that could not answer the code", async () => {
    const { page, fills, clicks } = makeJaverianaPage(
      [{ url: CHOOSER_URL, screen: "chooser" }],
      { onGoto: [{ url: CREDENTIALS_URL, screen: "credentials" }] },
    );

    await expect(new JaverianaSSOFlow(credentials).login(page as never)).rejects.toThrow(/authenticator code.*auth/);
    expect(fills).toEqual({});
    expect(clicks).toEqual([]);
  });

  it("still fills the password for a visible browser, where the person answers the code", async () => {
    const { page, fills } = makeJaverianaPage(
      [{ url: CHOOSER_URL, screen: "chooser" }],
      {
        onGoto: [{ url: CREDENTIALS_URL, screen: "credentials" }],
        onSubmitCredentials: [{ url: TOKEN_URL, screen: "token" }, { url: HOME_URL, screen: "home" }],
      },
    );

    await expect(new JaverianaSSOFlow({ ...credentials, headless: false }).login(page as never)).resolves.toBe(true);
    expect(fills[SELECTORS.password]).toBe("secret");
    expect(fills[SELECTORS.token]).toBeUndefined();
  });

  it("re-checks the host before the password and refuses a lookalike IdP page mid-flow", async () => {
    const requestMfaCode = vi.fn(async () => "123456");
    // The chooser's own GET redirects somewhere that merely looks like OneGate.
    const { page, fills } = makeJaverianaPage(
      [{ url: CHOOSER_URL, screen: "chooser" }],
      { onGoto: [{ url: LOOKALIKE_CREDENTIALS_URL, screen: "credentials" }] },
    );

    await expect(new JaverianaSSOFlow({ ...credentials, requestMfaCode }).login(page as never))
      .rejects.toBeInstanceOf(UnsupportedAuthenticationError);
    expect(fills).toEqual({});
    expect(requestMfaCode).not.toHaveBeenCalled();
  });

  it("never types credentials into a page that is not OneGate", async () => {
    const { page, fills } = makeJaverianaPage([{ url: "https://phish.example/mg-local/login?type=webtoken", screen: "credentials" }]);

    await expect(new JaverianaSSOFlow({ ...credentials, requestMfaCode: async () => "123456" }).login(page as never))
      .rejects.toBeInstanceOf(UnsupportedAuthenticationError);
    expect(fills).toEqual({});
  });

  it("requires a saved username and password before entering the credentials form", async () => {
    const { page } = makeJaverianaPage(
      [{ url: CHOOSER_URL, screen: "chooser" }],
      { onGoto: [{ url: CREDENTIALS_URL, screen: "credentials" }] },
    );

    const failure = new JaverianaSSOFlow({ ...credentials, username: undefined, requestMfaCode: async () => "123456" }).login(page as never);
    await expect(failure).rejects.toBeInstanceOf(BrowserAuthError);
    await expect(failure).rejects.toMatchObject({ step: "credentials" });
  });

  it("times out an unanswered challenge as an MFA failure", async () => {
    const { page } = makeJaverianaPage([{ url: TOKEN_URL, screen: "token" }]);

    await expect(new JaverianaSSOFlow({ ...credentials, headless: false }).login(page as never))
      .rejects.toBeInstanceOf(MfaApprovalError);
  });

  it("gives up with a pointer to visible-browser mode when no supported step ever appears", async () => {
    const { page } = makeJaverianaPage([{ url: `${ONEGATE}/enigmadialog`, screen: "blank" }]);

    await expect(new JaverianaSSOFlow({ ...credentials, requestMfaCode: async () => "123456" }).login(page as never))
      .rejects.toThrow(/D2L_HEADLESS=false/);
  });

  it("leaves a marker-less interstitial page alone instead of yanking it back to the credentials form", async () => {
    // A transient SAML auto-post / processing page: on OneGate's host, but
    // with neither the username/token fields nor the chooser's own link.
    const { page } = makeJaverianaPage([{ url: `${ONEGATE}/saml/auto-post`, screen: "blank" }]);

    await new JaverianaSSOFlow({ ...credentials, requestMfaCode: async () => "123456" }).selectIdentityProvider(page as never);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("opens the credentials form at most once per login, even if OneGate keeps showing the chooser", async () => {
    // No onGoto transition: the mock page never actually leaves the chooser
    // screen, isolating the "at most once" guarantee from navigation.
    const { page } = makeJaverianaPage([{ url: CHOOSER_URL, screen: "chooser" }]);

    await expect(new JaverianaSSOFlow({ ...credentials, requestMfaCode: async () => "123456" }).login(page as never))
      .rejects.toThrow(/D2L_HEADLESS=false/);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it("stops with setup guidance when OneGate's error banner appears after the password is submitted", async () => {
    const { page } = makeJaverianaPage(
      [{ url: CHOOSER_URL, screen: "chooser" }],
      {
        onGoto: [{ url: CREDENTIALS_URL, screen: "credentials" }],
        onSubmitCredentials: [{ url: CREDENTIALS_URL, screen: "credentials-error" }],
      },
    );

    const failure = new JaverianaSSOFlow({ ...credentials, requestMfaCode: async () => "123456" }).login(page as never);
    await expect(failure).rejects.toBeInstanceOf(BrowserAuthError);
    await expect(failure).rejects.toMatchObject({ step: "credentials" });
    await expect(failure).rejects.toThrow(/setup.*--javeriana/);
  });

  it("re-prompts for the authenticator code when the entry is not 6-8 digits", async () => {
    const requestMfaCode = vi.fn()
      .mockResolvedValueOnce("12")
      .mockResolvedValueOnce("123456");
    const { page, fills, clicks } = makeJaverianaPage(
      [{ url: TOKEN_URL, screen: "token" }],
      { onSubmitCode: [{ url: TOKEN_URL, screen: "blank" }, { url: HOME_URL, screen: "home" }] },
    );

    await expect(new JaverianaSSOFlow({ ...credentials, requestMfaCode }).login(page as never)).resolves.toBe(true);
    expect(requestMfaCode).toHaveBeenCalledTimes(2);
    expect(fills[SELECTORS.token]).toBe("123456");
    expect(clicks).toEqual([SELECTORS.tokenSubmit]);
  });

  it("gives up on the code challenge after repeated malformed entries", async () => {
    const requestMfaCode = vi.fn(async () => "not-a-code");
    const { page } = makeJaverianaPage([{ url: TOKEN_URL, screen: "token" }]);

    await expect(new JaverianaSSOFlow({ ...credentials, requestMfaCode }).login(page as never))
      .rejects.toThrow(/6-8 digits/);
    expect(requestMfaCode).toHaveBeenCalledTimes(3);
  });
});
