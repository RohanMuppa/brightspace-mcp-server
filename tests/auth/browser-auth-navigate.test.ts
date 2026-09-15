import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BrowserAuth, BrowserAuthTransportError } from "../../src/auth/browser-auth.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Regression tests for navigateAndLogin()'s already-authenticated detection.
 *
 * The detection is a POSITIVE check, never "the URL doesn't look like a login
 * page": institutions bounce through intermediate SAML hops with a perfectly
 * live session, and the login stub sets cookies of its own. So a session counts
 * as live only when the d2lSessionVal cookie is present AND the D2L JS context
 * is reachable, and the check runs on a bounded poll so a dead D2L session with
 * a live Entra cookie can re-mint itself through the no-secret surfaces.
 */

const BASE_URL = "https://brightspace.example.edu";

const EMAIL_SELECTOR = "input[type=email]";
const ALTERNATE_EMAIL_SELECTOR = "input[name=loginfmt]";
const SAOTCC_SELECTOR = "#idDiv_SAOTCC_Title";
const CAMPUS_SELECTOR = 'a[href*="/d2l/lp/auth/saml/initiate-login"]';
const KMSI_CHECKBOX = "#KmsiCheckboxField";
const KMSI_SUBMIT = "#idSIButton9";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: BASE_URL,
    sessionDir: "/tmp/does-not-matter",
    tokenTtl: 3600,
    headless: true,
    username: "student@example.edu",
    password: "hunter2",
    courseFilter: {} as AppConfig["courseFilter"],
    ...overrides,
  };
}

interface FakeState {
  url: string;
  cookies: Array<{ name: string; value: string }>;
  d2l: boolean;
  visible: string[];
}

interface FakePageOptions {
  url?: string;
  /** A live session: the cookie alone is not enough, D2L.LP has to answer too. */
  cookies?: Array<{ name: string; value: string }>;
  d2l?: boolean;
  /** Selectors (and "text:..." keys) the page reports as on screen. */
  visible?: string[];
  /** Mutate the page between polls, the way a real redirect chain would. */
  onTick?: (state: FakeState) => void;
}

/**
 * Fake Page covering everything the silent-SSO poll touches: the cookie jar,
 * the D2L JS context, selector visibility, and the clicks it performs.
 */
function makePage(options: FakePageOptions = {}) {
  const state: FakeState = {
    url: options.url ?? `${BASE_URL}/d2l/home`,
    cookies: options.cookies ?? [],
    d2l: options.d2l ?? false,
    visible: options.visible ?? [],
  };
  const clicks: string[] = [];

  const target = (key: string) => ({
    first: () => ({
      isVisible: async () => state.visible.includes(key),
      click: async () => {
        clicks.push(key);
      },
    }),
  });

  const page = {
    goto: vi.fn(async () => null),
    url: vi.fn(() => state.url),
    waitForURL: vi.fn(async () => {
      throw new Error("Timeout waiting for URL");
    }),
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async (ms: number) => {
      vi.advanceTimersByTime(ms);
      options.onTick?.(state);
    }),
    // Runs the real predicate against a stubbed window, so the test exercises
    // the same expression the browser would.
    evaluate: vi.fn(async (fn: () => unknown) => {
      const globals = globalThis as unknown as Record<string, unknown>;
      const previous = globals.window;
      globals.window = state.d2l ? { D2L: { LP: {} } } : {};
      try {
        return fn();
      } finally {
        if (previous === undefined) delete globals.window;
        else globals.window = previous;
      }
    }),
    context: vi.fn(() => ({ cookies: vi.fn(async () => state.cookies) })),
    locator: vi.fn((selector: string) => target(selector)),
    getByText: vi.fn((text: string) => target(`text:${text}`)),
  };

  return { page, clicks, state };
}

const LIVE_SESSION = {
  cookies: [{ name: "d2lSessionVal", value: "abc123" }],
  d2l: true,
};

describe("BrowserAuth.navigateAndLogin", () => {
  let auth: BrowserAuth;
  let ssoFlow: {
    login: ReturnType<typeof vi.fn>;
    manualLogin: ReturnType<typeof vi.fn>;
    hasCredentials: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    auth = new BrowserAuth(makeConfig());
    ssoFlow = {
      login: vi.fn(async (page: any) => {
        page.context = () => ({ cookies: async () => LIVE_SESSION.cookies });
        page.evaluate = async () => true;
        page.url = () => `${BASE_URL}/d2l/home`;
        return true;
      }),
      manualLogin: vi.fn(async () => true),
      hasCredentials: vi.fn(() => true),
    };
    // navigateAndLogin is private; swap the SSO flow so we can assert it stays unused.
    (auth as any).ssoFlow = ssoFlow;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const navigate = (page: unknown): Promise<boolean> =>
    (auth as any).navigateAndLogin(page);

  const withConfig = (overrides: Partial<AppConfig>) => {
    (auth as any).config = makeConfig(overrides);
  };

  it("waits for an intermediate SAML hop to reach the authenticated home page", async () => {
    const { page } = makePage({
      url: `${BASE_URL}/d2l/lp/auth/login/samlLogin.d2l`,
      ...LIVE_SESSION,
      onTick: (state) => { state.url = `${BASE_URL}/d2l/home`; },
    });

    await expect(navigate(page)).resolves.toBe(true);
    expect(ssoFlow.login).not.toHaveBeenCalled();
    expect(ssoFlow.manualLogin).not.toHaveBeenCalled();
    expect(page.waitForTimeout).toHaveBeenCalledOnce();
  });

  it("does not accept the login shell even when it defines D2L.LP and stale cookies", async () => {
    const { page } = makePage({ url: `${BASE_URL}/d2l/login`, ...LIVE_SESSION });
    await expect(navigate(page)).rejects.toBeInstanceOf(BrowserAuthTransportError);
    expect(ssoFlow.login).not.toHaveBeenCalled();
  });

  it("returns a temporary failure when a SAML redirect remains inconclusive", async () => {
    const { page } = makePage({
      url: "https://sso.example.edu/idp/profile/SAML2/Redirect/SSO",
    });

    await expect(navigate(page)).rejects.toBeInstanceOf(BrowserAuthTransportError);
    expect(ssoFlow.login).not.toHaveBeenCalled();
    // The whole 30s budget was spent before giving up.
    expect(page.waitForTimeout).toHaveBeenCalledTimes(30);
  });

  it("hands an inconclusive page to a configured visible browser", async () => {
    withConfig({ headless: false });
    const { page, state } = makePage({
      url: "https://idp.example.edu/custom-login",
    });
    page.waitForURL.mockImplementation(async () => {
      state.url = `${BASE_URL}/d2l/home`;
      state.cookies = LIVE_SESSION.cookies;
      state.d2l = true;
    });

    await expect(navigate(page)).resolves.toBe(false);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(30);
    expect(page.waitForURL).toHaveBeenCalledOnce();
    expect(ssoFlow.login).not.toHaveBeenCalled();
  });

  it("short-circuits without waiting when the first check finds a live session", async () => {
    const { page, clicks } = makePage({ url: `${BASE_URL}/d2l/home`, ...LIVE_SESSION });

    await expect(navigate(page)).resolves.toBe(true);
    expect(page.waitForURL).not.toHaveBeenCalled();
    expect(page.waitForTimeout).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
    expect(ssoFlow.login).not.toHaveBeenCalled();
  });

  it("does not treat a session cookie without a D2L JS context as authenticated", async () => {
    const { page } = makePage({
      url: `${BASE_URL}/d2l/home`,
      cookies: [{ name: "d2lSessionVal", value: "abc123" }],
      d2l: false,
    });

    await expect(navigate(page)).rejects.toBeInstanceOf(BrowserAuthTransportError);
    expect(ssoFlow.login).not.toHaveBeenCalled();
  });

  it("does not submit credentials after a browser cookie probe fails", async () => {
    const { page } = makePage({ url: `${BASE_URL}/d2l/home`, visible: [EMAIL_SELECTOR] });
    page.context = vi.fn(() => ({ cookies: vi.fn(async () => { throw new Error("Browser transport unavailable"); }) }));
    await expect(navigate(page)).rejects.toBeInstanceOf(BrowserAuthTransportError);
    expect(ssoFlow.login).not.toHaveBeenCalled();
  });

  it("does not submit credentials after a D2L JavaScript probe fails", async () => {
    const { page } = makePage({ url: `${BASE_URL}/d2l/home`, ...LIVE_SESSION, visible: [EMAIL_SELECTOR] });
    page.evaluate = vi.fn(async () => { throw new Error("Execution context unavailable"); });
    await expect(navigate(page)).rejects.toBeInstanceOf(BrowserAuthTransportError);
    expect(ssoFlow.login).not.toHaveBeenCalled();
  });

  it("gives up at once on a visible email field instead of burning the budget", async () => {
    const { page } = makePage({
      url: "https://login.microsoftonline.com/common/oauth2/authorize",
      visible: [EMAIL_SELECTOR],
    });

    await expect(navigate(page)).resolves.toBe(false);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
    expect(ssoFlow.login).toHaveBeenCalledOnce();
  });

  it("detects a visible later email selector independently", async () => {
    const { page } = makePage({
      url: "https://login.microsoftonline.com/common/oauth2/authorize",
      visible: [ALTERNATE_EMAIL_SELECTOR],
    });

    await expect(navigate(page)).resolves.toBe(false);
    expect(ssoFlow.login).toHaveBeenCalledOnce();
  });

  it("passes a SAOTCC-only MFA challenge to the school flow", async () => {
    const { page } = makePage({
      url: "https://login.microsoftonline.com/common/SAS/BeginAuth",
      visible: [SAOTCC_SELECTOR],
    });

    await expect(navigate(page)).resolves.toBe(false);
    expect(ssoFlow.login).toHaveBeenCalledOnce();
  });

  it("keeps a configured visible browser open for manual sign-in", async () => {
    withConfig({ headless: false, username: undefined, password: undefined });
    ssoFlow.hasCredentials.mockReturnValue(false);
    const { page, state } = makePage({
      url: "https://login.microsoftonline.com/common/oauth2/authorize",
      visible: [EMAIL_SELECTOR],
    });
    page.waitForURL.mockImplementation(async () => {
      state.url = `${BASE_URL}/d2l/home`;
      state.cookies = LIVE_SESSION.cookies;
      state.d2l = true;
    });

    await expect(navigate(page)).resolves.toBe(false);
    expect(page.waitForURL).toHaveBeenCalledOnce();
    expect(ssoFlow.login).not.toHaveBeenCalled();
  });

  it("still rejects missing credentials immediately in headless mode", async () => {
    ssoFlow.hasCredentials.mockReturnValue(false);
    const { page } = makePage({
      url: "https://login.microsoftonline.com/common/oauth2/authorize",
      visible: [EMAIL_SELECTOR],
    });

    await expect(navigate(page)).rejects.toThrow("Automatic sign-in requires saved credentials");
    expect(page.waitForURL).not.toHaveBeenCalled();
    expect(ssoFlow.login).not.toHaveBeenCalled();
  });

  it("times out a visible login with an interactive error", async () => {
    withConfig({ headless: false, username: undefined, password: undefined });
    ssoFlow.hasCredentials.mockReturnValue(false);
    const { page } = makePage({
      url: "https://login.microsoftonline.com/common/oauth2/authorize",
      visible: [EMAIL_SELECTOR],
    });

    await expect(navigate(page)).rejects.toMatchObject({ step: "interactive_login" });
    expect(ssoFlow.login).not.toHaveBeenCalled();
  });

  it("continues polling after the initial navigation times out", async () => {
    const { page } = makePage({
      url: `${BASE_URL}/d2l/lp/auth/login/samlLogin.d2l`,
      ...LIVE_SESSION,
      onTick: (state) => { state.url = `${BASE_URL}/d2l/home`; },
    });
    page.goto.mockRejectedValue(new Error("Timeout 60000ms exceeded"));

    await expect(navigate(page)).resolves.toBe(true);
    expect(page.goto).toHaveBeenCalledWith(`${BASE_URL}/d2l/home`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    expect(ssoFlow.login).not.toHaveBeenCalled();
  });

  it("leaves #idSIButton9 alone when nothing proves the page is the KMSI page", async () => {
    const { page, clicks } = makePage({
      url: "https://login.microsoftonline.com/common/login",
      visible: [KMSI_SUBMIT],
    });

    await expect(navigate(page)).rejects.toBeInstanceOf(BrowserAuthTransportError);
    expect(ssoFlow.login).not.toHaveBeenCalled();
    expect(clicks).toEqual([]);
  });

  it("clicks #idSIButton9 once the KMSI checkbox proves the page", async () => {
    const { page, clicks } = makePage({
      url: "https://login.microsoftonline.com/common/kmsi",
      visible: [KMSI_CHECKBOX, KMSI_SUBMIT],
      onTick: (state) => {
        // The click lands, the SSO chain finishes, the next poll sees a session.
        state.visible = [];
        state.cookies = LIVE_SESSION.cookies;
        state.d2l = true;
        state.url = `${BASE_URL}/d2l/home`;
      },
    });

    await expect(navigate(page)).resolves.toBe(true);
    expect(clicks).toEqual([KMSI_SUBMIT]);
  });

  it('accepts "Stay signed in?" as the KMSI marker when the checkbox is hidden', async () => {
    const { page, clicks } = makePage({
      url: "https://login.microsoftonline.com/common/kmsi",
      visible: ["text:Stay signed in?", KMSI_SUBMIT],
      onTick: (state) => {
        state.visible = [];
        state.cookies = LIVE_SESSION.cookies;
        state.d2l = true;
        state.url = `${BASE_URL}/d2l/home`;
      },
    });

    await expect(navigate(page)).resolves.toBe(true);
    expect(clicks).toEqual([KMSI_SUBMIT]);
  });

  it("clicks the campus selector only on a /d2l/login page", async () => {
    const { page, clicks } = makePage({
      url: `${BASE_URL}/d2l/login`,
      visible: [CAMPUS_SELECTOR],
      onTick: (state) => {
        state.visible = [];
        state.cookies = LIVE_SESSION.cookies;
        state.d2l = true;
        state.url = `${BASE_URL}/d2l/home`;
      },
    });

    await expect(navigate(page)).resolves.toBe(true);
    expect(clicks).toEqual([CAMPUS_SELECTOR]);
  });

  it("prefers the configured campus by name over the generic SAML link", async () => {
    withConfig({ campus: "Albany" });
    const { page, clicks } = makePage({
      url: `${BASE_URL}/d2l/login`,
      visible: ["text:Albany", CAMPUS_SELECTOR],
      onTick: (state) => {
        state.visible = [];
        state.cookies = LIVE_SESSION.cookies;
        state.d2l = true;
        state.url = `${BASE_URL}/d2l/home`;
      },
    });

    await expect(navigate(page)).resolves.toBe(true);
    expect(clicks).toEqual(["text:Albany"]);
  });
});
