/** CUNY login entry point. Licensed under MIT; see LICENSE. */

import type { Page } from "playwright";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { AUTH_COMMAND, SETUP_COMMAND } from "../utils/commands.js";
import { MfaApprovalError, UnsupportedAuthenticationError } from "./sso-flow.js";
import type { OnMfaChallenge, RequestMfaCode } from "./sso-flow.js";

/** All CUNY campuses share one Brightspace tenant behind CUNY Login (Oracle OAM). */
const CUNY_BRIGHTSPACE_HOST = "brightspace.cuny.edu";
const CUNY_LOGIN_HOST = "ssologin.cuny.edu";

/**
 * Oracle JET generates the authenticator-code field's id with a pipe in it,
 * which is not valid in an `#id` selector, so match the attribute instead.
 * browser-auth.ts lists the same selector so a run that resumes on this page
 * is recognized as an MFA challenge.
 */
export const CUNY_TOTP_SELECTOR = '[id="otpValue|input"]';

const SELECTORS = {
  // The visible field takes the full @login.cuny.edu address. CUNY's own
  // submit handler copies the short name into a hidden #CUNYLoginUsername,
  // so that hidden field is left for the page to fill.
  username: "#CUNYLoginUsernameDisplay",
  password: "#CUNYLoginPassword",
  submit: "#submit",
  // Only rendered on the reload OAM serves after rejecting the password.
  serverError: "#serverError",
  totp: CUNY_TOTP_SELECTOR,
} as const;

const POLL_MS = 500;
/** CUNY parks on a processing page for about ten seconds before the code challenge. */
const CHALLENGE_TIMEOUT_MS = 60_000;
/** A person has to find their authenticator and read a code. */
const MFA_TIMEOUT_MS = 5 * 60 * 1000;

interface CunySSOConfig {
  username?: string;
  password?: string;
  baseUrl?: string;
  headless?: boolean;
  requestMfaCode?: RequestMfaCode;
  onMfaChallenge?: OnMfaChallenge;
}

/** True for the shared CUNY Brightspace instance. */
export function isCunyBrightspace(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === CUNY_BRIGHTSPACE_HOST;
  } catch {
    return false;
  }
}

/** Compare hosts, not substrings: the SAML round trip carries other hosts in its query. */
function isCunyLogin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === CUNY_LOGIN_HOST;
  } catch {
    return false;
  }
}

/** A rejected code reloads the challenge with `?emsg=Entered+TOTP+is+incorrect.` */
function hasErrorMessage(url: string): boolean {
  try {
    return new URL(url).searchParams.has("emsg");
  } catch {
    return false;
  }
}

/**
 * Login flow for CUNY Brightspace.
 *
 * Brightspace federates by SAML to CUNY Login at ssologin.cuny.edu, an Oracle
 * Access Manager page rather than Entra, Shibboleth, or Duo:
 *
 *   /d2l/login → /oamfed/idp/samlv20 (username + password)
 *     → /oaa/authnui (a "Processing Request" page, roughly ten seconds)
 *     → /oaa-totp-factor/rui/index.html (authenticator code) → /d2l/home
 *
 * Its username field is a plain text input, which none of the default flow's
 * username selectors match, and its code challenge is an Oracle JET page the
 * default MFA loop does not know. The code itself still comes from a person,
 * through the same terminal prompt or visible browser every other code-based
 * MFA uses.
 */
export class CunySSOFlow {
  private readonly config: CunySSOConfig;

  constructor(config: CunySSOConfig) {
    this.config = config;
  }

  hasCredentials(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  async login(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting CUNY Login sign-in flow");
      await this.completeLogin(page);
      return true;
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new UnsupportedAuthenticationError("CUNY Login could not complete automatic sign-in. Check saved credentials and your authenticator settings.", error as Error);
    }
  }

  /**
   * Poll the page and answer whichever CUNY Login step is on screen. A run
   * can hand over mid-flow (awaitSilentSSO also stops on the code page), so
   * no step is assumed to come first.
   */
  private async completeLogin(page: Page): Promise<void> {
    // A visible browser may be answering a different CUNY MFA method by hand.
    let deadline = Date.now() + (this.config.headless === false ? MFA_TIMEOUT_MS : CHALLENGE_TIMEOUT_MS);
    let credentialsSubmitted = false;
    let challenged = false;
    /** The challenge URL a code was submitted from; a reload away from it with ?emsg= is a rejection. */
    let codeSubmittedFrom: string | null = null;
    let announced = false;

    while (Date.now() < deadline) {
      if (await this.isAuthenticated(page)) {
        log("INFO", "Login successful - verified Brightspace home");
        return;
      }

      // Never type the CUNY password into anything but CUNY Login itself.
      if (isCunyLogin(page.url())) {
        if (await this.isVisible(page, SELECTORS.serverError)) {
          throw new BrowserAuthError(`CUNY Login rejected the saved username or password. Run \`${SETUP_COMMAND} --cuny\` to update them.`, "credentials");
        }

        if (await this.isVisible(page, SELECTORS.totp)) {
          if (!challenged) {
            challenged = true;
            deadline = Date.now() + MFA_TIMEOUT_MS;
          }
          if (this.config.headless === false) {
            // The person at the window types the code and can retry a typo
            // there, so a rejection is theirs to answer, not a failure here.
            if (!announced) {
              announced = true;
              log("WARN", "Enter the code from your authenticator app in the CUNY Login window. Waiting up to 5 minutes.");
              this.config.onMfaChallenge?.(null);
            }
          } else {
            const url = page.url();
            if (codeSubmittedFrom !== null && url !== codeSubmittedFrom && hasErrorMessage(url)) {
              throw new MfaApprovalError(new Error("CUNY Login rejected the authenticator code."));
            }
            if (codeSubmittedFrom === null) {
              codeSubmittedFrom = url;
              await this.submitCode(page);
            }
          }
        } else if (!credentialsSubmitted && await this.isVisible(page, SELECTORS.username)) {
          // CUNY Login asks for a code on every full sign-in and does not
          // re-federate Brightspace from its own cookies, so a headless run with
          // no terminal (the MCP server's background re-authentication) can
          // never finish. Stop before the password is sent: otherwise every tool
          // call after the session ends posts it again, and a stale saved
          // password would keep counting toward a CUNY lockout.
          if (this.config.headless !== false && !this.config.requestMfaCode) throw this.codePromptUnavailable();
          credentialsSubmitted = true;
          await this.enterCredentials(page);
        }
      }

      await page.waitForTimeout(POLL_MS);
    }

    if (challenged) throw new MfaApprovalError();
    throw new UnsupportedAuthenticationError("CUNY Login did not reach the authenticator-code challenge or Brightspace. If your default CUNY MFA method is not an authenticator app, set D2L_HEADLESS=false and finish sign-in in the browser.");
  }

  private async enterCredentials(page: Page): Promise<void> {
    if (!this.config.username) throw new BrowserAuthError("Username is required for SSO login", "credentials");
    if (!this.config.password) throw new BrowserAuthError("Password is required for SSO login", "credentials");

    log("INFO", "Entering CUNY Login credentials");
    await page.locator(SELECTORS.username).first().fill(this.config.username);
    await page.locator(SELECTORS.password).first().fill(this.config.password);
    // OAM answers the POST with a full navigation, which can detach the button.
    await page.locator(SELECTORS.submit).first().click().catch(() => {});
  }

  private codePromptUnavailable(): UnsupportedAuthenticationError {
    return new UnsupportedAuthenticationError(
      `CUNY Login requires an authenticator code. Run \`${AUTH_COMMAND}\` in a terminal to enter it.`,
    );
  }

  /** Feed CUNY's code challenge from the terminal prompt. */
  private async submitCode(page: Page): Promise<void> {
    if (!this.config.requestMfaCode) throw this.codePromptUnavailable();
    const code = (await this.config.requestMfaCode()).replace(/\s/g, "");
    if (!/^\d{6,8}$/.test(code)) throw new UnsupportedAuthenticationError("The MFA code must contain 6-8 digits.");

    await page.locator(SELECTORS.totp).first().fill(code);
    // Oracle JET gives the Verify button no id; its label is the stable handle.
    const verify = page.getByRole("button", { name: /^\s*verify\s*$/i }).first();
    if (await verify.isVisible().catch(() => false)) await verify.click().catch(() => {});
    else await page.locator(SELECTORS.totp).first().press("Enter");
    log("INFO", "Authenticator code submitted");
  }

  private async isVisible(page: Page, selector: string): Promise<boolean> {
    return page.locator(selector).first().isVisible().catch(() => false);
  }

  /** The login shell also exposes D2L.LP, so verify origin and home as well. */
  private async isAuthenticated(page: Page): Promise<boolean> {
    try {
      const expected = new URL(this.config.baseUrl ?? `https://${CUNY_BRIGHTSPACE_HOST}`);
      const current = new URL(page.url());
      if (current.origin !== expected.origin || !/^\/d2l\/home(?:\/|$)/.test(current.pathname)) return false;
      const cookies = await page.context().cookies(expected.origin);
      if (!cookies.some(cookie => cookie.name === "d2lSessionVal" && Boolean(cookie.value))) return false;
      return await page.evaluate(() => {
        const d2l = (window as unknown as Record<string, unknown>).D2L as Record<string, unknown> | undefined;
        return Boolean(d2l?.LP);
      });
    } catch {
      // Redirects can replace the execution context mid-check. Keep polling.
      return false;
    }
  }
}
