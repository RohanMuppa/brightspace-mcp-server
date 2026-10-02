import { describe, expect, it, vi } from "vitest";
import { createSSOFlow, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import { McgillSSOFlow, isMcgillBrightspace } from "../../src/auth/mcgill-sso.js";
import type { AppConfig } from "../../src/types/index.js";

const MCGILL_URL = "https://mycourses2.mcgill.ca";

describe("McGill sign-in entry point", () => {
  it("routes only McGill's exact Brightspace host to its handler", () => {
    expect(isMcgillBrightspace(MCGILL_URL)).toBe(true);
    expect(isMcgillBrightspace(`${MCGILL_URL}.example.com`)).toBe(false);
    expect(createSSOFlow({ baseUrl: MCGILL_URL } as AppConfig)).toBeInstanceOf(McgillSSOFlow);
  });

  it("navigates to the SAML endpoint from McGill's login page", async () => {
    // A healthy SAML endpoint redirects off mycourses2.mcgill.ca to Entra.
    let currentUrl = `${MCGILL_URL}/d2l/login`;
    const goto = vi.fn(async () => {
      currentUrl = "https://login.microsoftonline.com/common/login";
    });
    const page = {
      url: () => currentUrl,
      goto,
    };
    await new McgillSSOFlow({ baseUrl: MCGILL_URL }).prepareLogin(page as never);
    expect(goto).toHaveBeenCalledWith(`${MCGILL_URL}/d2l/lp/auth/saml/login`, expect.any(Object));
  });

  it("does not navigate once already past the login page", async () => {
    const goto = vi.fn(async () => {});
    const page = { url: () => "https://login.microsoftonline.com/common/login", goto };
    await new McgillSSOFlow({ baseUrl: MCGILL_URL }).prepareLogin(page as never);
    expect(goto).not.toHaveBeenCalled();
  });

  it("does not navigate when the host is not McGill, even with a /d2l/login path", async () => {
    const goto = vi.fn(async () => {});
    const page = { url: () => "https://mycourses2.mcgill.ca.example.com/d2l/login", goto };
    await new McgillSSOFlow({ baseUrl: MCGILL_URL }).prepareLogin(page as never);
    expect(goto).not.toHaveBeenCalled();
  });

  it("does not navigate from an http:// page even on the McGill host and login path", async () => {
    const goto = vi.fn(async () => {});
    const page = { url: () => "http://mycourses2.mcgill.ca/d2l/login", goto };
    await new McgillSSOFlow({ baseUrl: MCGILL_URL }).prepareLogin(page as never);
    expect(goto).not.toHaveBeenCalled();
  });

  it("throws when the SAML endpoint fails to redirect off mycourses2.mcgill.ca", async () => {
    let currentUrl = `${MCGILL_URL}/d2l/login`;
    const goto = vi.fn(async (target: string) => {
      currentUrl = target;
    });
    const page = { url: () => currentUrl, goto };
    await expect(new McgillSSOFlow({ baseUrl: MCGILL_URL }).prepareLogin(page as never))
      .rejects.toBeInstanceOf(UnsupportedAuthenticationError);
    expect(goto).toHaveBeenCalledWith(`${MCGILL_URL}/d2l/lp/auth/saml/login`, expect.any(Object));
  });

  it("does not throw on an unparseable or blank URL", async () => {
    const goto = vi.fn(async () => {});
    const page = { url: () => "about:blank", goto };
    await expect(new McgillSSOFlow({ baseUrl: MCGILL_URL }).prepareLogin(page as never)).resolves.toBeUndefined();
    expect(goto).not.toHaveBeenCalled();
  });

  it("passes rememberMfa and onMfaChallenge configuration through to the shared flow", () => {
    const onMfaChallenge = vi.fn();
    const flow = new McgillSSOFlow({ baseUrl: MCGILL_URL, onMfaChallenge, rememberMfa: true });
    expect(flow.hasCredentials()).toBe(false);
    // rememberMfaResult must delegate to the inner PurdueSSOFlow, not be a method of its own.
    expect(flow.rememberMfaResult()).toBeUndefined();
  });
});
