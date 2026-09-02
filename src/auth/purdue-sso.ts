/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { ElementHandle, Page } from "playwright";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

const SELECTORS = {
  usernameInput: "input#username",
  passwordInput: "input#password",
  submitButton: 'button[name="_eventId_proceed"]',
  staySignedInYes: "input[type=submit][value='Yes']",
  // Purdue's proceed button, D2L's own, and the generic submit used by Entra
  // (input#idSIButton9) and most other identity providers.
  formSubmit: 'button[name="_eventId_proceed"], button.d2l-button, input[type="submit"]',
} as const;

// Entra labels the account-name button "Next" and only shows "Sign in" on the
// view that follows. Both are input#idSIButton9, so the label tells them apart.
const ACCOUNT_NAME_BUTTON = /^next$/i;

/**
 * Entra's number-match digits. The tenant shows a two-digit number that has to
 * be typed into Microsoft Authenticator, and nothing else on the machine
 * reveals it, so a headless run stalls forever unless this is scraped and
 * logged. Plain DOM text, no OCR.
 */
const NUMBER_MATCH_SELECTOR = "#idRichContext_DisplaySign";

/** How often to look for the number while waiting on MFA. */
const NUMBER_MATCH_POLL_MS = 2000;

/** A person has to find their phone, unlock it, and read a prompt. */
const MFA_TIMEOUT_MS = 5 * 60 * 1000;

/** Visible text of a button, or the value of a submit input. */
async function controlLabel(
  handle: ElementHandle<SVGElement | HTMLElement>
): Promise<string> {
  return handle.evaluate((el) =>
    ((el as HTMLInputElement).value || el.textContent || "").trim()
  );
}

interface PurdueSSOConfig {
  username?: string;
  password?: string;
}

export class PurdueSSOFlow {
  private config: PurdueSSOConfig;

  constructor(config: PurdueSSOConfig) {
    this.config = config;
  }

  /**
   * Returns true if credentials are available for automated SSO login.
   */
  hasCredentials(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  /**
   * Execute the complete Microsoft Entra ID SSO login flow for Purdue.
   * Handles institution selector, email/password entry, MFA (TOTP or manual), and "stay signed in" prompt.
   *
   * @param page - Playwright page instance (already navigated to Brightspace or redirected to login)
   * @returns true on successful login (URL contains /d2l/home), false on timeout/failure
   */
  async login(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting SSO login flow");

      // Step 1: Handle campus selector on purdue.brightspace.com/d2l/login
      await this.handleCampusSelector(page);

      // Step 2: Enter username + password on sso.purdue.edu (Shibboleth)
      await this.enterCredentials(page);

      // Step 3: Handle MFA (TOTP automated or manual approval)
      await this.handleMFA(page);

      // Step 4: Handle "Stay signed in?" prompt
      await this.handleStaySignedIn(page);

      // Step 5: Wait for successful redirect to Brightspace home
      await page.waitForURL(/\/d2l\/home/, { timeout: 120000 });
      log("INFO", "Login successful - reached Brightspace home");

      return true;
    } catch (error) {
      log("ERROR", "SSO login flow failed", error);
      return false;
    }
  }

  /**
   * Manual login fallback: let the user type credentials and complete MFA themselves.
   * The browser stays open in headed mode while we wait for /d2l/home.
   */
  async manualLogin(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting manual login flow (no saved credentials)");
      log("INFO", "Please log in using the browser window that just opened.");

      // Navigate past the campus selector so the user lands on the Shibboleth form
      await this.handleCampusSelector(page);

      // Wait up to 5 minutes for the user to complete login manually
      log("INFO", "Waiting up to 5 minutes for you to complete login and MFA...");
      await page.waitForURL(/\/d2l\/home/, { timeout: 300000 });
      log("INFO", "Manual login successful - reached Brightspace home");

      return true;
    } catch (error) {
      log("ERROR", "Manual login flow failed or timed out", error);
      return false;
    }
  }

  private async handleCampusSelector(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (currentUrl.includes("purdue.brightspace.com") && currentUrl.includes("/d2l/login")) {
      // Campus selector buttons are inside a shadow DOM — navigate directly
      // to Purdue's Shibboleth SAML endpoint instead of clicking them
      const baseUrl = new URL(currentUrl).origin;
      log("INFO", "Campus selector detected — navigating directly to Shibboleth IdP");
      await page.goto(
        `${baseUrl}/d2l/lp/auth/saml/initiate-login?entityId=https://idp.purdue.edu/idp/shibboleth`,
        { waitUntil: "networkidle", timeout: 30000 }
      );
    }
    // Already on sso.purdue.edu or past the campus selector — nothing to do
  }

  private async enterCredentials(page: Page): Promise<void> {
    try {
      log("DEBUG", "Waiting for login form");
      
      // Wait for either Purdue's username or Albany's userName (or typical email fields)
      // Use a shorter timeout so it falls back to manual login quickly if unrecognized
      const usernameSelector = 'input#username, input#userName, input[type="email"]';
      await page.waitForSelector(usernameSelector, { timeout: 10000 });

      if (!this.config.username) {
        throw new BrowserAuthError(
          "Username is required for SSO login",
          "credentials"
        );
      }

      if (!this.config.password) {
        throw new BrowserAuthError(
          "Password is required for SSO login",
          "credentials"
        );
      }

      log("INFO", "Entering credentials");
      const usernameField = await this.findVisible(page, usernameSelector);
      if (usernameField) {
        await usernameField.fill(this.config.username);
      }

      // Microsoft Entra puts a password box on its account-name page as well,
      // but the button there only advances to the next view. Submit the account
      // name first so the password lands on the page that actually signs in.
      await this.submitAccountName(page);

      const passwordSelector = 'input#password, input[type="password"]';
      const passwordField = await this.findVisible(page, passwordSelector);
      if (passwordField) {
        await passwordField.fill(this.config.password);
      }

      const submitButton = await this.findVisible(page, SELECTORS.formSubmit);
      if (submitButton) {
        await submitButton.click();
      } else {
        // Fallback: just hit Enter on the password field
        await passwordField?.press('Enter');
      }

      await page.waitForLoadState("networkidle");
    } catch (error) {
      log("WARN", "Automated credentials entry failed, will fallback to manual login.", error);
      throw error;
    }
  }

  /**
   * Resolve a control only when it is actually on screen.
   *
   * Entra is a single-page app: the account-name view stays in the DOM once
   * the password view replaces it, so a plain page.$() returns the hidden
   * first-page input or button that precedes the live one in document order.
   * Filling or clicking those stalls on Playwright's actionability wait.
   */
  private async findVisible(
    page: Page,
    selector: string
  ): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
    for (const handle of await page.$$(selector)) {
      if (await handle.isVisible()) return handle;
    }
    return null;
  }

  /**
   * Advance Microsoft Entra's account-name page.
   *
   * That page carries a password box of its own, and Playwright reports it as
   * visible, so presence cannot tell it apart from a single-page form. The
   * button label can: it reads "Next" there and "Sign in" on the view that
   * follows. Filling the password against the account-name page leaves the
   * browser parked with both fields populated and nothing submitted.
   */
  private async submitAccountName(page: Page): Promise<void> {
    const submit = await this.findVisible(page, SELECTORS.formSubmit);
    if (!submit) return;
    if (!ACCOUNT_NAME_BUTTON.test(await controlLabel(submit))) return;

    log("INFO", "Account-name page detected — submitting account name");
    await submit.click();

    // The sign-in view has arrived once the button stops saying "Next".
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.waitForTimeout(500);
      const current = await this.findVisible(page, SELECTORS.formSubmit);
      if (current && !ACCOUNT_NAME_BUTTON.test(await controlLabel(current))) return;
    }
    log("WARN", "Sign-in page did not appear after submitting the account name");
  }

  private async handleMFA(page: Page): Promise<void> {
    // The number is only on screen while MFA is pending, so the scrape has to
    // run alongside the wait rather than before or after it.
    const pending = { done: false };
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const watcher = this.watchNumberMatch(page, pending, released);

    try {
      log("WARN", "Waiting for Microsoft MFA approval on your device...");
      log("INFO", "Timeout: 5 minutes");
      log("INFO", "Approve the sign-in request in Microsoft Authenticator. If it shows a number, it is printed below.");

      // Wait for MFA approval by watching for the post-MFA redirect.
      // Using waitForURL instead of networkidle because networkidle fires
      // after 500ms of no network activity, which can happen while the MFA
      // page UI finishes loading but before the user approves the request.
      await page.waitForURL(
        (url) => {
          const href = url.toString();
          return href.includes("/d2l/") ||
                 href.includes("kmsi") ||
                 href.includes("/sso/") ||
                 href.includes("SAMLResponse");
        },
        { timeout: MFA_TIMEOUT_MS }
      );
      log("INFO", `MFA completed - redirected to: ${page.url()}`);
    } catch (error) {
      throw new BrowserAuthError(
        "MFA approval timed out after 5 minutes",
        "mfa_approval",
        error as Error
      );
    } finally {
      pending.done = true;
      release();
      await watcher;
    }
  }

  /**
   * Log Entra's number-match digits until the MFA wait is over.
   *
   * Only a CHANGED value is logged: Entra re-mints the number whenever the
   * user asks for a new request, and repeating the same digits every two
   * seconds would bury everything else in the log.
   */
  private async watchNumberMatch(
    page: Page,
    pending: { done: boolean },
    released: Promise<void>
  ): Promise<void> {
    let last: string | null = null;
    while (!pending.done) {
      const number = await this.readNumberMatch(page);
      if (number && number !== last) {
        last = number;
        log("WARN", `Number match: ${number}. Enter it in Microsoft Authenticator.`);
      }
      // Racing the release keeps the wait from outliving the MFA it watches.
      await Promise.race([
        page.waitForTimeout(NUMBER_MATCH_POLL_MS).catch(() => {}),
        released,
      ]);
    }
  }

  /** The digits on screen, or null when Entra is not showing any. */
  private async readNumberMatch(page: Page): Promise<string | null> {
    const sign = page.locator(NUMBER_MATCH_SELECTOR).first();
    // isVisible answers immediately rather than waiting out a timeout, so the
    // runs that never show a number keep the poll on its two-second rhythm.
    if (!(await sign.isVisible().catch(() => false))) return null;
    const text = await sign.textContent().catch(() => null);
    return text?.trim() || null;
  }

  private async handleStaySignedIn(page: Page): Promise<void> {
    try {
      log("DEBUG", "Checking for 'Stay signed in?' prompt");
      const staySignedInButton = await page.waitForSelector(
        SELECTORS.staySignedInYes,
        { timeout: 10000 }
      );
      if (staySignedInButton) {
        log("INFO", "Clicking 'Yes' on 'Stay signed in?' prompt");
        await staySignedInButton.click();
        await page.waitForLoadState("networkidle");
      }
    } catch (error) {
      // Prompt may not appear - this is normal
      log("DEBUG", "No 'Stay signed in?' prompt found (this is normal)");
    }
  }
}
