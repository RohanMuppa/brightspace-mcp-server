import { afterEach, describe, expect, it, vi } from "vitest";
import { createSSOFlow, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import { isTUDelftBrightspace, TUDelftSSOFlow } from "../../src/auth/tudelft-sso.js";
import type { AppConfig } from "../../src/types/index.js";

const BASE = "https://brightspace.tudelft.nl";
const IDP = "https://login.tudelft.nl/idp/profile/SAML2/Redirect/SSO";
const config = { username: "fixture-netid", password: "fixture-password" };

function fixture(options: { url?: string; consent?: boolean; rejected?: boolean; redirectOnUsername?: boolean; stall?: boolean } = {}) {
  let current = options.url ?? IDP;
  let submitted = false;
  const fills: Array<[string, string]> = [];
  const clicks: string[] = [];
  const page = {
    url: () => current,
    locator: vi.fn((selector: string) => ({ first: () => ({
      isVisible: async () => {
        if (current === IDP) return ['input#username', 'input#password', '#submit_button'].includes(selector)
          || (selector === '[role="alert"]' && submitted && options.rejected === true);
        return current.startsWith('https://engine.surfconext.nl/') && selector === '#consent_accept';
      },
      fill: async (value: string) => {
        fills.push([selector, value]);
        if (options.redirectOnUsername && selector === 'input#username') current = 'https://example.org/login';
      },
      click: async () => {
        clicks.push(selector);
        submitted = true;
        if (!options.rejected && !options.stall) current = options.consent && selector !== '#consent_accept'
          ? 'https://engine.surfconext.nl/consent' : `${BASE}/d2l/home`;
      },
    }) })),
    waitForTimeout: vi.fn(async () => { if (options.stall) vi.advanceTimersByTime(60_001); }),
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
