/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

const SELECTORS = {
  usernameInput: "input#username",
  passwordInput: "input#password",
  submitButton: 'button[name="_eventId_proceed"]',
  staySignedInYes: "input[type=submit][value='Yes']",
} as const;

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
      log("INFO", "Starting Purdue SSO login flow");

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
      // Try to figure out which input actually exists
      const usernameField = await page.$(usernameSelector);
      if (usernameField) {
        await usernameField.fill(this.config.username);
      }

      const passwordSelector = 'input#password, input[type="password"]';
      const passwordField = await page.$(passwordSelector);
      if (passwordField) {
        await passwordField.fill(this.config.password);
      }

      // Try to click the submit button. Could be Purdue's proceed, or Albany's Log In, or a generic button
      const submitSelector = 'button[name="_eventId_proceed"], button.d2l-button, input[type="submit"]';
      const submitButton = await page.$(submitSelector);
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

  private async handleMFA(page: Page): Promise<void> {
    try {
      log("WARN", "Waiting for Microsoft MFA approval on your device...");
      log("INFO", "Timeout: 120 seconds");
      log("INFO", "Browser is running in headed mode - please approve the MFA request on your phone");

      // Wait for MFA approval by watching for the post-MFA redirect.
      // Using waitForURL instead of networkidle because networkidle fires
      // after 500ms of no network activity, which can happen while the MFA
      // page UI finishes loading but before the user approves the Duo push.
      await page.waitForURL(
        (url) => {
          const href = url.toString();
          return href.includes("/d2l/") ||
                 href.includes("kmsi") ||
                 href.includes("/sso/") ||
                 href.includes("SAMLResponse");
        },
        { timeout: 120000 }
      );
      log("INFO", `MFA completed — redirected to: ${page.url()}`);
    } catch (error) {
      throw new BrowserAuthError(
        "MFA approval timed out after 120 seconds",
        "mfa_approval",
        error as Error
      );
    }
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
