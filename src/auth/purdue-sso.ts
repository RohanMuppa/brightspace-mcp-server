/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT : see LICENSE file for details.
 */

import type { Locator, Page } from "playwright";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { MfaApprovalError, UnsupportedAuthenticationError } from "./sso-flow.js";
import type { RequestMfaCode } from "./sso-flow.js";
import { AUTH_COMMAND } from "../utils/commands.js";

const EMAIL_SELECTORS = ["input[type=email]", "input[name=loginfmt]"];
const PASSWORD_SELECTORS = ["input[type=password]", "input[name=passwd]"];
const SUBMIT_SELECTORS = ["#idSIButton9", "input[type=submit]", "button[type=submit]"];
const FIELD_TIMEOUT_MS = 30_000;
const FIELD_POLL_MS = 250;

/**
 * Entra's number-match digits. The tenant shows a two-digit number that has to
 * be typed into Microsoft Authenticator, and nothing else on the machine
 * reveals it, so a headless run stalls forever unless this is scraped and
 * logged. Plain DOM text, no OCR.
 */
const NUMBER_MATCH_SELECTOR = "#idRichContext_DisplaySign";
const MFA_CODE_SELECTORS = ["#idTxtBx_SAOTCC_OTC", 'input[name="otc"]'];
const MFA_CODE_SUBMIT_SELECTORS = ["#idSubmit_SAOTCC_Continue", "#idSIButton9"];

/** How often to look for the number while waiting on MFA. */
const NUMBER_MATCH_POLL_MS = 2000;

/** A person has to find their phone, unlock it, and read a prompt. */
const MFA_TIMEOUT_MS = 5 * 60 * 1000;

interface PurdueSSOConfig {
  username?: string;
  password?: string;
  baseUrl?: string;
  headless?: boolean;
  requestMfaCode?: RequestMfaCode;
}

/** Microsoft expects Purdue's full sign-in name, while setup also accepts a career account. */
function signInName(username: string, baseUrl?: string): string {
  const isPurdue = baseUrl && new URL(baseUrl).hostname.toLowerCase() === "purdue.brightspace.com";
  return isPurdue && !username.includes("@") ? `${username}@purdue.edu` : username;
}

export class PurdueSSOFlow {
  private config: PurdueSSOConfig;
  private accountHintSubmitted = false;

  constructor(config: PurdueSSOConfig) {
    this.config = config;
  }

  /**
   * Returns true if credentials are available for automated SSO login.
   */
  hasCredentials(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  async prepareLogin(page: Page): Promise<void> {
    await this.handleCampusSelector(page);
  }

  /** First half of Brightspace Bar's choreography, with no password access. */
  async identifyAccount(page: Page): Promise<boolean> {
    if (!this.config.username) return false;
    const email = signInName(this.config.username, this.config.baseUrl);
    if (!await this.fillWhenReady(page, EMAIL_SELECTORS, email)) return false;
    if (!await this.clickWhenReady(page, SUBMIT_SELECTORS)) return false;
    this.accountHintSubmitted = true;
    return true;
  }

  /**
   * Execute the complete Microsoft Entra ID SSO login flow for Purdue.
   * Handles the school selector, saved credentials, device MFA approval, and stay-signed-in.
   *
   * @param page - Playwright page instance (already navigated to Brightspace or redirected to login)
   * @returns true after reaching Brightspace home; failures are typed errors
   */
  async login(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting SSO login flow");

      // Step 1: Handle campus selector on purdue.brightspace.com/d2l/login
      await this.handleCampusSelector(page);

      // Restored Microsoft state can lead directly to MFA or stay-signed-in.
      const postCredential = await this.anyVisible(page, [
        NUMBER_MATCH_SELECTOR,
        "#idDiv_SAOTCAS_Title",
        "#idDiv_SAOTCC_Title",
        "#KmsiCheckboxField",
      ]);
      const kmsi = await page.getByText("Stay signed in?").first().isVisible().catch(() => false);
      if (!page.url().includes("/d2l/home") && !postCredential && !kmsi) await this.enterCredentials(page);

      // Wait for device approval and print Microsoft's number match.
      await this.handleMFA(page);

      return true;
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new UnsupportedAuthenticationError("The identity provider could not complete headless sign-in. Check saved credentials and supported MFA settings.", error as Error);
    }
  }

  private async handleCampusSelector(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (currentUrl.includes("purdue.brightspace.com") && currentUrl.includes("/d2l/login")) {
      // Follow the live Purdue control first, as Brightspace Bar does, so a
      // tenant-side destination change does not leave this client behind.
      const campus = page.getByText(/Purdue West Lafayette/i).first();
      if (await campus.isVisible().catch(() => false)) {
        log("INFO", "Campus selector detected : selecting Purdue West Lafayette");
        await campus.click();
        return;
      }

      // Retain the known endpoint as a fallback if the control has not rendered.
      const baseUrl = new URL(currentUrl).origin;
      log("INFO", "Campus selector detected : navigating directly to Shibboleth IdP");
      await page.goto(
        `${baseUrl}/d2l/lp/auth/saml/initiate-login?entityId=https://idp.purdue.edu/idp/shibboleth`,
        { waitUntil: "domcontentloaded", timeout: 30000 }
      );
    }
    // Already on sso.purdue.edu or past the campus selector : nothing to do
  }

  private async enterCredentials(page: Page): Promise<void> {
    if (!this.config.username) throw new BrowserAuthError("Username is required for SSO login", "credentials");
    if (!this.config.password) throw new BrowserAuthError("Password is required for SSO login", "credentials");

    log("INFO", "Entering credentials");
    if (!this.accountHintSubmitted) {
      const email = signInName(this.config.username, this.config.baseUrl);
      if (!await this.fillWhenReady(page, EMAIL_SELECTORS, email)) {
        throw new UnsupportedAuthenticationError("The Microsoft email field did not appear. Headless sign-in cannot continue.");
      }
      if (!await this.clickWhenReady(page, SUBMIT_SELECTORS)) {
        throw new UnsupportedAuthenticationError("The Microsoft email submit button did not appear. Headless sign-in cannot continue.");
      }
    }
    this.accountHintSubmitted = false;
    if (!await this.fillWhenReady(page, PASSWORD_SELECTORS, this.config.password)) {
      throw new UnsupportedAuthenticationError("The Microsoft password field did not appear. Headless sign-in cannot continue.");
    }
    if (!await this.clickWhenReady(page, SUBMIT_SELECTORS)) {
      throw new UnsupportedAuthenticationError("The Microsoft password submit button did not appear. Headless sign-in cannot continue.");
    }
  }

  /** Ported from Brightspace Bar's proven four-step Entra choreography. */
  private async actWhenReady(page: Page, selectors: string[], act: (target: Locator) => Promise<void>): Promise<boolean> {
    const deadline = Date.now() + FIELD_TIMEOUT_MS;
    do {
      for (const selector of selectors) {
        const target = page.locator(selector).first();
        if (await target.isVisible().catch(() => false)) {
          await act(target);
          return true;
        }
      }
      await page.waitForTimeout(FIELD_POLL_MS);
    } while (Date.now() < deadline);
    return false;
  }

  private async fillWhenReady(page: Page, selectors: string[], value: string): Promise<boolean> {
    return this.actWhenReady(page, selectors, target => target.fill(value));
  }

  private async clickWhenReady(page: Page, selectors: string[]): Promise<boolean> {
    // Entra often detaches the button after the click has already navigated.
    return this.actWhenReady(page, selectors, target => target.click().catch(() => {}));
  }

  /** Match Brightspace Bar's selector loop instead of trusting the first DOM match. */
  private async anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
    for (const selector of selectors) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
    }
    return false;
  }

  /** Brightspace Bar's bounded number/auth/KMSI polling loop. */
  private async handleMFA(page: Page): Promise<void> {
    if (!this.config.baseUrl) {
      throw new UnsupportedAuthenticationError("A school URL is required to verify headless authentication.");
    }
    const deadline = Date.now() + MFA_TIMEOUT_MS;
    let challenged = false;
    let announced: string | null = null;
    try {
      while (Date.now() < deadline) {
        if (await this.submitMfaCode(page)) challenged = true;
        const number = await this.readNumberMatch(page);
        const challengeVisible = number !== null ||
          await page.locator("#idDiv_SAOTCAS_Title").first().isVisible().catch(() => false) ||
          await page.locator("#idDiv_SAOTCC_Title").first().isVisible().catch(() => false);
        if (challengeVisible && !challenged) {
          challenged = true;
          log("WARN", "Waiting up to 5 minutes for Microsoft MFA approval on your device.");
        }
        if (number && number !== announced) {
          announced = number;
          log("WARN", `Number match: ${number}. Enter it in Microsoft Authenticator.`);
        }
        if (await this.isAuthenticated(page)) {
          log("INFO", "Login successful - verified Brightspace home");
          return;
        }
        await this.clickProvenKmsi(page);
        await page.waitForTimeout(NUMBER_MATCH_POLL_MS);
      }
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      if (challenged) throw new MfaApprovalError(error as Error);
      throw new UnsupportedAuthenticationError("Headless sign-in stopped before a supported MFA challenge completed.", error as Error);
    }
    if (challenged) throw new MfaApprovalError();
    throw new UnsupportedAuthenticationError("Sign-in did not reach a supported MFA challenge or Brightspace within 5 minutes.");
  }

  private async submitMfaCode(page: Page): Promise<boolean> {
    const input = await this.firstVisible(page, MFA_CODE_SELECTORS);
    if (!input) return false;
    if (this.config.headless === false) return false;
    if (!this.config.requestMfaCode) {
      throw new UnsupportedAuthenticationError(
        `This MFA method requires a code. Run \`${AUTH_COMMAND}\` in a terminal to enter it.`,
      );
    }
    const code = await this.config.requestMfaCode();
    if (!/^\d{6,8}$/.test(code)) throw new UnsupportedAuthenticationError("The MFA code must contain 6-8 digits.");
    await input.fill(code);
    const submit = await this.firstVisible(page, MFA_CODE_SUBMIT_SELECTORS);
    if (submit) await submit.click();
    else await input.press("Enter");
    log("INFO", "Authenticator code submitted");
    return true;
  }

  private async firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | null> {
    for (const selector of selectors) {
      const target = page.locator(selector).first();
      if (await target.isVisible().catch(() => false)) return target;
    }
    return null;
  }

  /** The login shell also exposes D2L.LP, so verify origin and home as well. */
  private async isAuthenticated(page: Page): Promise<boolean> {
    try {
      const expected = new URL(this.config.baseUrl!);
      const current = new URL(page.url());
      if (current.origin !== expected.origin || !/^\/d2l\/home(?:\/|$)/.test(current.pathname)) return false;
      const cookies = await page.context().cookies(expected.origin);
      if (!cookies.some(cookie => cookie.name === "d2lSessionVal" && Boolean(cookie.value))) return false;
      return await page.evaluate(() => {
        const d2l = (window as unknown as Record<string, unknown>).D2L as Record<string, unknown> | undefined;
        return Boolean(d2l?.LP);
      });
    } catch {
      // Redirects can replace the execution context. Keep polling; this
      // verdict never causes credentials to be entered a second time.
      return false;
    }
  }

  private async clickProvenKmsi(page: Page): Promise<void> {
    if (new URL(page.url()).hostname !== "login.microsoftonline.com") return;
    const proven =
      await page.locator("#KmsiCheckboxField").first().isVisible().catch(() => false) ||
      await page.getByText("Stay signed in?").first().isVisible().catch(() => false);
    if (!proven) return;
    const yes = page.locator("#idSIButton9").first();
    if (await yes.isVisible().catch(() => false)) {
      await yes.click().catch(() => {});
      log("DEBUG", 'Clicked Yes on "Stay signed in?"');
    }
  }

  /** The digits on screen, or null when Entra is not showing any. */
  private async readNumberMatch(page: Page): Promise<string | null> {
    const sign = page.locator(NUMBER_MATCH_SELECTOR).first();
    // isVisible answers immediately rather than waiting out a timeout, so the
    // runs that never show a number keep the poll on its two-second rhythm.
    if (!(await sign.isVisible().catch(() => false))) return null;
    const text = await sign.textContent().catch(() => null);
    const number = text?.trim();
    return number && /^\d{1,3}$/.test(number) ? number : null;
  }

}
