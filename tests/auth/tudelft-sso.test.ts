import { afterEach, describe, expect, it, vi } from "vitest";
import { createSSOFlow, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import { isTUDelftBrightspace, TUDelftSSOFlow } from "../../src/auth/tudelft-sso.js";
import type { AppConfig } from "../../src/types/index.js";

const BASE = "https://brightspace.tudelft.nl";
const IDP = "https://login.tudelft.nl/idp/profile/SAML2/Redirect/SSO";
const config = { username: "fixture-netid", password: "fixture-password" };

function fixture(options: {
  url?: string;
  consent?: boolean;
  rejected?: boolean;
  benignAlert?: boolean;
  redirectOnUsername?: boolean;
  stall?: boolean;
} = {}) {
  let current = options.url ?? IDP;
  let submitted = false;
  const fills: Array<[string, string]> = [];
  const clicks: string[] = [];
  const page = {
    url: () => current,
    locator: vi.fn((selector: string) => ({ first: () => ({
      isVisible: async () => {
        if (current === IDP) {
          if (['input#username', 'input#password', '#submit_button'].includes(selector)) return true;
          if (selector === '[role="alert"]' && submitted && (options.rejected === true || options.benignAlert === true)) return true;
          return false;
        }
        return current.startsWith('https://engine.surfconext.nl/') && selector === '#consent_accept';
      },
      textContent: async () => {
        if (options.rejected === true) return 'Incorrect username or password. Please try again.';
        if (options.benignAlert === true) return 'This site uses cookies to improve your experience.';
        return '';
      },
      fill: async (value: string) => {
        fills.push([selector, value]);
        if (options.redirectOnUsername && selector === 'input#username') current = 'https://example.org/login';
      },
      click: async () => {
        clicks.push(selector);
        submitted = true;
        if (!options.rejected && !options.benignAlert && !options.stall) current = options.consent && selector !== '#consent_accept'
          ? 'https://engine.surfconext.nl/consent' : `${BASE}/d2l/home`;
      },
    }) })),
    waitForTimeout: vi.fn(async (ms: number) => {
      if (options.stall) { vi.advanceTimersByTime(60_001); return; }
      // Drive the fake clock forward for scenarios that need several polls to
      // observe (e.g. the settle window before an alert is trusted) without
      // waiting on it in real time.
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    }),
  };
  return { page, fills, clicks };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("TU Delft NetID sign-in", () => {
  it("selects the handler by the exact Brightspace host", () => {
    expect(isTUDelftBrightspace(BASE)).toBe(true);
    expect(isTUDelftBrightspace('https://BRIGHTSPACE.TUDELFT.NL/d2l/home')).toBe(true);
    expect(isTUDelftBrightspace(`${BASE}.example.org`)).toBe(false);
    expect(isTUDelftBrightspace('https://example.org/?next=brightspace.tudelft.nl')).toBe(false);
    expect(isTUDelftBrightspace('not-a-url')).toBe(false);
    expect(createSSOFlow({ baseUrl: BASE, ...config, headless: true } as AppConfig)).toBeInstanceOf(TUDelftSSOFlow);
  });

  it("requires both credentials for automated NetID login", () => {
    expect(new TUDelftSSOFlow(config).hasCredentials()).toBe(true);
    expect(new TUDelftSSOFlow({ username: config.username }).hasCredentials()).toBe(false);
    expect(new TUDelftSSOFlow({ password: config.password }).hasCredentials()).toBe(false);
  });

  it("submits the NetID form and reaches Brightspace without an MFA step", async () => {
    const f = fixture();
    expect(await new TUDelftSSOFlow(config).login(f.page as never)).toBe(true);
    expect(f.fills).toEqual([['input#username', config.username], ['input#password', config.password]]);
    expect(f.clicks).toEqual(['#submit_button']);
  });

  it("accepts a first-use SURFconext consent after NetID login", async () => {
    const f = fixture({ consent: true });
    expect(await new TUDelftSSOFlow(config).login(f.page as never)).toBe(true);
    expect(f.clicks).toEqual(['#submit_button', '#consent_accept']);
  });

  it.each([
    'https://login.tudelft.nl.example.org/login',
    'https://example.org/?next=login.tudelft.nl',
    'http://login.tudelft.nl/login',
    'https://another.brightspace.com/d2l/home',
  ])("never enters credentials on an untrusted page: %s", async (url) => {
    const f = fixture({ url });
    await expect(new TUDelftSSOFlow(config).login(f.page as never)).rejects.toBeInstanceOf(UnsupportedAuthenticationError);
    expect(f.fills).toEqual([]);
    expect(f.page.locator).not.toHaveBeenCalled();
  });

  it("does not send the password after leaving NetID during account entry", async () => {
    const f = fixture({ redirectOnUsername: true });
    await expect(new TUDelftSSOFlow(config).login(f.page as never)).rejects.toThrow('trusted NetID page');
    expect(f.fills).toEqual([['input#username', config.username]]);
  });

  it("does not repeatedly submit rejected credentials", async () => {
    const f = fixture({ rejected: true });
    await expect(new TUDelftSSOFlow(config).login(f.page as never)).rejects.toThrow('sign-in was rejected');
    expect(f.clicks).toEqual(['#submit_button']);
  });

  it("ignores a standing non-error alert banner instead of treating it as a rejection", async () => {
    vi.useFakeTimers();
    const f = fixture({ benignAlert: true });
    const error = await new TUDelftSSOFlow(config).login(f.page as never).catch((e: unknown) => e);
    // The benign banner persists for the whole attempt (it never matches the
    // rejection text), so sign-in runs out the clock rather than reporting a
    // rejection it never actually saw.
    expect(error).toBeInstanceOf(UnsupportedAuthenticationError);
    expect((error as Error).message).not.toMatch(/was rejected/);
    expect((error as Error).message).toMatch(/did not reach Brightspace/);
    expect(f.clicks).toEqual(['#submit_button']);
  }, 15_000);

  it("bounds a stalled sign-in and returns an actionable failure", async () => {
    vi.useFakeTimers();
    const f = fixture({ stall: true });
    await expect(new TUDelftSSOFlow(config).login(f.page as never)).rejects.toThrow('D2L_HEADLESS=false');
    expect(f.clicks).toEqual(['#submit_button']);
  });

  it("leaves login to the caller when credentials are missing", async () => {
    const f = fixture();
    expect(await new TUDelftSSOFlow({}).login(f.page as never)).toBe(false);
    expect(f.fills).toEqual([]);
  });
});
