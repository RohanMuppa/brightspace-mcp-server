/**
 * McGill University login entry point. Licensed under MIT; see LICENSE.
 *
 * McGill flow ported from chrldb's mcgill-sso branch (MIT).
 */

import type { Page } from "playwright";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { UnsupportedAuthenticationError } from "./sso-flow.js";
import type { RememberMfaResult } from "./microsoft-session.js";

const MCGILL_HOST = "mycourses2.mcgill.ca";

export function isMcgillBrightspace(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === MCGILL_HOST;
  } catch {
    return false;
  }
}

/**
 * McGill's myCourses login page offers a "McGill" control that is really a
 * plain anchor to `/d2l/lp/auth/saml/login`, alongside separate guest/external
 * options. The tenant sits behind exactly one identity provider, so going
 * straight to that SAML endpoint is simpler than depending on the control's
 * markup, and skips it entirely. From there this reuses the shared credential
 * and MFA flow; only McGill's first click differs.
 */
export class McgillSSOFlow {
  private readonly common: PurdueSSOFlow;

  constructor(config: ConstructorParameters<typeof PurdueSSOFlow>[0]) {
    this.common = new PurdueSSOFlow(config);
  }

  hasCredentials(): boolean {
    return this.common.hasCredentials();
  }

  rememberMfaResult(): RememberMfaResult | undefined {
    return this.common.rememberMfaResult();
  }

  async prepareLogin(page: Page): Promise<void> {
    await this.startSamlLogin(page);
  }

  async identifyAccount(page: Page): Promise<boolean> {
    return this.common.identifyAccount(page);
  }

  async login(page: Page): Promise<boolean> {
    await this.startSamlLogin(page);
    return this.common.login(page);
  }

  /**
   * Skip McGill's login-option page entirely by going straight to the SAML
   * endpoint its "McGill" control would have reached. A no-op once already
   * past it (e.g. mid-MFA, or the account picker resumed a saved IdP
   * session), matching the other flows' idempotent prepareLogin/login calls.
   */
  private async startSamlLogin(page: Page): Promise<void> {
    let current: URL;
    try {
      current = new URL(page.url());
    } catch {
      return;
    }
    if (current.protocol !== "https:" || current.hostname.toLowerCase() !== MCGILL_HOST || !current.pathname.includes("/d2l/login")) return;

    await page.goto(`${current.origin}/d2l/lp/auth/saml/login`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // A healthy SAML endpoint redirects off mycourses2.mcgill.ca towards
    // Microsoft Entra. If the host is unchanged, the endpoint 404'd or
    // otherwise failed to redirect — fail fast with a clear message instead
    // of letting the inner Microsoft sign-in flow time out looking for
    // fields that will never appear.
    let afterGoto: URL;
    try {
      afterGoto = new URL(page.url());
    } catch {
      return;
    }
    if (afterGoto.hostname.toLowerCase() === MCGILL_HOST) {
      throw new UnsupportedAuthenticationError(
        "McGill sign-in could not reach the SAML endpoint (mycourses2.mcgill.ca/d2l/lp/auth/saml/login stayed on the same host) — myCourses may have changed its login flow."
      );
    }
  }
}
