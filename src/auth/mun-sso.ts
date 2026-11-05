/** Memorial University of Newfoundland (MUN) login entry point. Licensed under MIT; see LICENSE. */

import type { Page } from "playwright";
import { log } from "../utils/logger.js";
import { SETUP_COMMAND } from "../utils/commands.js";
import { BrowserAuthError } from "../utils/errors.js";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { UnsupportedAuthenticationError } from "./sso-flow.js";
import type { RememberMfaResult } from "./microsoft-session.js";

const MUN_HOST = "online.mun.ca";
const CAS_HOST = "login.mun.ca";
const ENTRA_HOST = "login.microsoftonline.com";

const SELECTORS = {
  loginButton: "#mun-login",
  username: "input#username",
  password: "input#password",
  submit: 'button[name="submitBtn"]',
} as const;

const POLL_MS = 500;
const HEADLESS_TIMEOUT_MS = 60_000;
/** A visible window may have a person finishing a page this flow does not know. */
const VISIBLE_TIMEOUT_MS = 5 * 60 * 1000;

export function isMunBrightspace(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === MUN_HOST;
  } catch {
    return false;
  }
}

function secureHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * MUN's Brightspace lands on its own page at /d2l/loginh/, whose "MUN Login"
 * button leads to MUN's CAS server, not to SAML or Microsoft:
 *
 *   /d2l/loginh/ -> /d2l/custom/cas -> login.mun.ca/cas/login -> /d2l/home
 *
 * The default flow never clicks that button, and CAS's plain `username` field
 * matches none of its username selectors. Seen live on 2026-11-05.
 *
 * If MUN ever sends the login on to Microsoft, the shared flow takes over from
 * there, which answers "Stay signed in?", "Don't ask again" and code prompts.
 */
export class MunSSOFlow {
  private readonly common: PurdueSSOFlow;
  private readonly config: ConstructorParameters<typeof PurdueSSOFlow>[0];

  constructor(config: ConstructorParameters<typeof PurdueSSOFlow>[0]) {
    this.config = config;
    this.common = new PurdueSSOFlow(config);
  }

  hasCredentials(): boolean {
    return this.common.hasCredentials();
  }

  rememberMfaResult(): RememberMfaResult | undefined {
    return this.common.rememberMfaResult();
  }

  /** Called on every poll, so a button that has not rendered yet is simply tried again. */
  async prepareLogin(page: Page): Promise<void> {
    if (secureHost(page.url()) !== MUN_HOST || !new URL(page.url()).pathname.startsWith("/d2l/login")) return;
    const button = page.locator(SELECTORS.loginButton).first();
    if (await button.isVisible().catch(() => false)) {
      log("DEBUG", "Clicked the MUN Login button");
      await button.click().catch(() => {});
    }
  }

  async login(page: Page): Promise<boolean> {
    const deadline = Date.now() + (this.config.headless === false ? VISIBLE_TIMEOUT_MS : HEADLESS_TIMEOUT_MS);
    let submitted = false;
    let navigatedAfterSubmit = false;
    const onNavigated = (frame: unknown) => {
      if (submitted && frame === page.mainFrame()) navigatedAfterSubmit = true;
    };
    page.on("framenavigated", onNavigated);
    try {
      while (Date.now() < deadline) {
        const host = secureHost(page.url());
        if (host === MUN_HOST && /^\/d2l\/home(?:\/|$)/.test(new URL(page.url()).pathname)) return true;
        if (host === ENTRA_HOST) return await this.common.login(page);
        await this.prepareLogin(page);

        // Never type the password into anything but MUN's own login server.
        if (host === CAS_HOST && await page.locator(SELECTORS.password).first().isVisible().catch(() => false)) {
          // The form coming back means CAS said no. Sending it again would only
          // count toward a lockout.
          if (navigatedAfterSubmit) {
            throw new BrowserAuthError(`MUN Login rejected the saved username or password. Run \`${SETUP_COMMAND} --mun\` to update them.`, "credentials");
          }
          if (!submitted) {
            submitted = true;
            await this.enterCredentials(page);
          }
        }
        await page.waitForTimeout(POLL_MS);
      }
    } finally {
      page.off("framenavigated", onNavigated);
    }
    throw new UnsupportedAuthenticationError("MUN sign-in did not reach Brightspace. MUN may have changed its login pages.");
  }

  private async enterCredentials(page: Page): Promise<void> {
    if (!this.config.username) throw new BrowserAuthError("Username is required for SSO login", "credentials");
    if (!this.config.password) throw new BrowserAuthError("Password is required for SSO login", "credentials");
    log("INFO", "Entering MUN Login credentials");
    await page.locator(SELECTORS.username).first().fill(this.config.username);
    await page.locator(SELECTORS.password).first().fill(this.config.password);
    // CAS answers with a full navigation, which can detach the button.
    await page.locator(SELECTORS.submit).first().click().catch(() => {});
  }
}
