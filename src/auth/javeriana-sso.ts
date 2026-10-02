/** Pontificia Universidad Javeriana Cali login via MobilityGuard OneGate. Licensed under MIT; see LICENSE. */

import type { Page } from "playwright";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { AUTH_COMMAND, SETUP_COMMAND } from "../utils/commands.js";
import { MfaApprovalError, UnsupportedAuthenticationError } from "./sso-flow.js";
import type { OnMfaChallenge, RequestMfaCode } from "./sso-flow.js";

/**
 * Ported from Joshua Mendez (@JoshuaMontclair)'s fork, branch
 * feat/javeriana-cali-sso (MIT). The fork's stored-TOTP-secret path and its
 * separate sso-factory.ts are not carried over: here, as with every other
 * code-based MFA in this project, the authenticator code is typed by a
 * person through the terminal prompt (see cuny-sso.ts, which this flow is
 * otherwise modeled on).
 *
 * Brightspace federates by SAML to MobilityGuard OneGate at
 * mg-local.servicios.javerianacali.edu.co:
 *
 *   /d2l/login → ... → IdP "Elija su método de autenticación" chooser
 *     → GET /mg-local/login?type=webtoken   ("Usuario y Contraseña")
 *     → (submit #form)   → an /auth/totp-pattern page asking for the code
 *     → (submit #otp-form) → /d2l/home
 *
 * Both the credentials form (#form) and the code form (#otp-form) copy their
 * typed values into hidden inputs from a submit handler wired up on `load`;
 * clicking before that handler attaches posts the hidden fields empty. Hence
 * `waitForLoadState("load")` before every click. The code field is rendered
 * visible but disabled at first paint, so being editable — not merely
 * visible — is the only honest sign that OneGate is ready for it.
 */

const JAVERIANA_BRIGHTSPACE_HOST = "auladigital.javerianacali.edu.co";
const ONEGATE_HOST = "mg-local.servicios.javerianacali.edu.co";

/** "Usuario y Contraseña" — OneGate's chooser link for password sign-in. */
const CREDENTIALS_FORM_PATH = "/mg-local/login?type=webtoken";

const SELECTORS = {
  username: "input#user-id",
  password: "input#password",
  token: "input#token",
  credentialsSubmit: 'form#form input[type="submit"]',
  tokenSubmit: 'form#otp-form input[type="submit"]',
  /** OneGate's status banner. Rendered hidden and unhidden to show errors. */
  statusMessage: ".box--system-message",
  /**
   * The method chooser's own "Usuario y Contraseña" link — a positive
   * marker that distinguishes the chooser from a transient interstitial
   * (a SAML auto-post, a "processing" page) that also lacks the
   * username/token fields but must not be navigated away from.
   */
  chooserLink: 'a[href*="type=webtoken"]',
} as const;

const POLL_MS = 500;
/** OneGate parks on the chooser and credentials form briefly before the code challenge. */
const CHALLENGE_TIMEOUT_MS = 60_000;
/** A person has to find their authenticator and read a code. */
const MFA_TIMEOUT_MS = 5 * 60 * 1000;
const FORM_NAVIGATION_TIMEOUT_MS = 30_000;
/** How many mistyped codes to re-prompt for before giving up on this challenge. */
const MAX_CODE_ATTEMPTS = 3;

interface JaverianaSSOConfig {
  username?: string;
  password?: string;
  baseUrl?: string;
  headless?: boolean;
  requestMfaCode?: RequestMfaCode;
  onMfaChallenge?: OnMfaChallenge;
}

/** True for Javeriana Cali's Brightspace tenant. */
export function isJaverianaBrightspace(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === JAVERIANA_BRIGHTSPACE_HOST;
  } catch {
    return false;
  }
}

/** Compare hosts, not substrings: a lookalike domain must never pass this check. */
function isOneGate(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === ONEGATE_HOST;
  } catch {
    return false;
  }
}

/**
 * Login flow for Javeriana Cali's Brightspace, behind MobilityGuard OneGate.
 *
 * OneGate's chooser is a plain GET link rather than a visible form, so
 * `selectIdentityProvider` follows it during the shared silent-SSO poll
 * (see browser-auth.ts's clickSilentSurfaces) before a human ever has to;
 * `login` calls the same step again in case nothing resolved it yet. The
 * authenticator code OneGate asks for afterward has no stored secret to
 * generate it from, so it comes from a person, through the same terminal
 * prompt or visible browser every other code-based MFA in this project uses.
 */
export class JaverianaSSOFlow {
  private readonly config: JaverianaSSOConfig;
  /** Guards the chooser-to-credentials-form redirect to at most once per login. */
  private credentialsFormOpened = false;

  constructor(config: JaverianaSSOConfig) {
    this.config = config;
  }

  hasCredentials(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  /** Follow OneGate's "Usuario y Contraseña" chooser link before a human has to. */
  async selectIdentityProvider(page: Page): Promise<void> {
    if (!isOneGate(page.url())) return;
    await this.openCredentialsForm(page);
  }

  async login(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting Javeriana Cali sign-in flow (MobilityGuard OneGate)");
      await this.completeLogin(page);
      return true;
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new UnsupportedAuthenticationError(
        "OneGate could not complete automatic sign-in. Check saved credentials and your authenticator settings.",
        error as Error,
      );
    }
  }

  /**
   * Poll the page and answer whichever OneGate step is on screen. A run can
   * hand over mid-flow (resumed re-authentication, or a run that handed off
   * to a visible browser), so no step is assumed to come first.
   */
  private async completeLogin(page: Page): Promise<void> {
    let deadline = Date.now() + (this.config.headless === false ? MFA_TIMEOUT_MS : CHALLENGE_TIMEOUT_MS);
    let credentialsSubmitted = false;
    let challenged = false;
    /** The page the code was submitted from; a reload away from it is a rejection. */
    let codeSubmittedFrom: string | null = null;
    let announced = false;

    while (Date.now() < deadline) {
      if (await this.isAuthenticated(page)) {
        log("INFO", "Login successful - verified Brightspace home");
        return;
      }

      if (isOneGate(page.url())) {
        await this.openCredentialsForm(page);
        this.reportStatusMessage(page);

        // The banner is also used for harmless notices before a password is
        // ever sent, so only treat it as a hard rejection once credentials
        // have actually been submitted — otherwise this would abort a login
        // that is still progressing normally.
        if (credentialsSubmitted && !challenged && await this.isVisible(page, SELECTORS.statusMessage)) {
          throw new BrowserAuthError(
            `OneGate rejected the saved username or password. Run \`${SETUP_COMMAND} --javeriana\` to update your password.`,
            "credentials",
          );
        }

        if (await this.isEditable(page, SELECTORS.token)) {
          if (!challenged) {
            challenged = true;
            deadline = Date.now() + MFA_TIMEOUT_MS;
          }
          if (this.config.headless === false && !this.config.requestMfaCode) {
            // The person at the window types the code and can retry a typo
            // there, so a rejection is theirs to answer, not a failure here.
            if (!announced) {
              announced = true;
              log("WARN", "Enter the authenticator code in the OneGate browser window. Waiting up to 5 minutes.");
              this.config.onMfaChallenge?.(null);
            }
          } else {
            const url = page.url();
            if (codeSubmittedFrom !== null && url !== codeSubmittedFrom) {
              throw new MfaApprovalError(new Error("OneGate rejected the authenticator code."));
            }
            if (codeSubmittedFrom === null) {
              if (this.config.headless !== false && !this.config.requestMfaCode) throw this.codePromptUnavailable();
              codeSubmittedFrom = url;
              await this.submitCode(page);
            }
          }
        } else if (!credentialsSubmitted && await this.isVisible(page, SELECTORS.username)) {
          // OneGate's authenticator code is required on every full sign-in and
          // there is no way to type it without a terminal or a visible window,
          // so a headless run with neither can never finish. Stop before the
          // password is sent: otherwise a stale saved password keeps getting
          // resubmitted on every background re-authentication attempt.
          if (this.config.headless !== false && !this.config.requestMfaCode) throw this.codePromptUnavailable();
          credentialsSubmitted = true;
          await this.enterCredentials(page);
        }
      }

      await page.waitForTimeout(POLL_MS);
    }

    if (challenged) throw new MfaApprovalError();
    throw new UnsupportedAuthenticationError(
      "OneGate did not reach the authenticator-code challenge or Brightspace. If your sign-in needs a different step, set D2L_HEADLESS=false and finish sign-in in the browser.",
    );
  }

  /**
   * Open the password form from OneGate's chooser. A no-op once a username
   * or code field is already on screen — a resumed run, or a redirect that
   * landed past the chooser on its own — once this redirect has already
   * run for this login, or when the current page is not actually the
   * chooser: a transient interstitial (a SAML auto-post, a "processing"
   * page between steps) also lacks the username/token fields, and
   * navigating away from it would abort an in-flight POST. The chooser's
   * own "Usuario y Contraseña" link is the positive signal that this really
   * is the chooser, safe to redirect from.
   */
  private async openCredentialsForm(page: Page): Promise<void> {
    const hasUsername = (await page.locator(SELECTORS.username).count()) > 0;
    const hasToken = (await page.locator(SELECTORS.token).count()) > 0;
    if (hasUsername || hasToken) return;
    if (this.credentialsFormOpened) return;

    const hasChooserLink = (await page.locator(SELECTORS.chooserLink).count()) > 0;
    if (!hasChooserLink) return;

    this.credentialsFormOpened = true;
    const { origin } = new URL(page.url());
    log("INFO", 'Opening the "Usuario y Contraseña" form');
    await page.goto(`${origin}${CREDENTIALS_FORM_PATH}`, {
      waitUntil: "load",
      timeout: FORM_NAVIGATION_TIMEOUT_MS,
    });
  }

  private async enterCredentials(page: Page): Promise<void> {
    if (!this.config.username) throw new BrowserAuthError("Username is required for SSO login", "credentials");
    if (!this.config.password) throw new BrowserAuthError("Password is required for SSO login", "credentials");

    // The handler that copies typed values into hidden fields attaches on
    // `load`; clicking before then posts the hidden inputs empty.
    await page.waitForLoadState("load");

    // Re-check immediately after the load wait and before either field is
    // touched: a navigation during that wait must never let a lookalike
    // host receive the username, let alone the password.
    this.assertOnOneGate(page, "entering credentials");

    log("INFO", "Entering credentials");
    await page.locator(SELECTORS.username).first().fill(this.config.username);
    await page.locator(SELECTORS.password).first().fill(this.config.password);
    await page.locator(SELECTORS.credentialsSubmit).first().click().catch(() => {});
  }

  private codePromptUnavailable(): UnsupportedAuthenticationError {
    return new UnsupportedAuthenticationError(
      `OneGate requires an authenticator code. Run \`${AUTH_COMMAND}\` in a terminal to enter it.`,
    );
  }

  /**
   * Feed OneGate's code challenge from the terminal prompt. Unlike the
   * other code-based flows, which validate once and bail, this re-prompts
   * on a malformed entry — the caller supplying requestMfaCode may not
   * already loop the way the CLI's own terminal prompt does.
   */
  private async submitCode(page: Page): Promise<void> {
    if (!this.config.requestMfaCode) throw this.codePromptUnavailable();

    let code: string | undefined;
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
      const typed = (await this.config.requestMfaCode()).replace(/\s/g, "");
      if (/^\d{6,8}$/.test(typed)) {
        code = typed;
        break;
      }
      log("WARN", "That does not look like a 6-8 digit authenticator code.");
    }
    if (!code) throw new UnsupportedAuthenticationError("The MFA code must contain 6-8 digits.");

    // The same submit-handler timing applies to the code form.
    await page.waitForLoadState("load");

    // Re-check immediately before the code, for the same reason as the password.
    this.assertOnOneGate(page, "entering the authenticator code");
    await page.locator(SELECTORS.token).first().fill(code);
    await page.locator(SELECTORS.tokenSubmit).first().click().catch(() => {});
    log("INFO", "Authenticator code submitted");
  }

  /** Never type a secret into anything but OneGate itself. */
  private assertOnOneGate(page: Page, action: string): void {
    if (!isOneGate(page.url())) {
      throw new UnsupportedAuthenticationError(
        `Javeriana sign-in reached an unsupported identity-provider page while ${action}. No credentials were entered there.`,
      );
    }
  }

  private async isVisible(page: Page, selector: string): Promise<boolean> {
    return page.locator(selector).first().isVisible().catch(() => false);
  }

  /**
   * Editable rather than visible: the code field is on the page, visible and
   * disabled, before the credentials step is submitted, so waiting for mere
   * visibility would fill a field the page is still ignoring.
   */
  private async isEditable(page: Page, selector: string): Promise<boolean> {
    return page.locator(selector).first().isEditable().catch(() => false);
  }

  /**
   * Surface OneGate's status banner (wrong password, locked account, ...) in
   * the logs if it appears. Deliberately non-blocking and advisory: the
   * banner is also used for harmless notices, so it must not abort a login
   * that is still progressing.
   */
  private reportStatusMessage(page: Page): void {
    const banner = page.locator(SELECTORS.statusMessage).first();
    banner
      .isVisible()
      .then(async (visible) => {
        if (!visible) return;
        const text = (await banner.textContent().catch(() => null))?.trim();
        if (text) log("WARN", `OneGate reported: ${text}`);
      })
      .catch(() => {
        // No banner, or the page navigated away first — both are expected.
      });
  }

  /** The login shell also exposes D2L.LP, so verify origin and home as well. */
  private async isAuthenticated(page: Page): Promise<boolean> {
    try {
      const expected = new URL(this.config.baseUrl ?? `https://${JAVERIANA_BRIGHTSPACE_HOST}`);
      const current = new URL(page.url());
      if (current.origin !== expected.origin || !/^\/d2l\/home(?:\/|$)/.test(current.pathname)) return false;
      const cookies = await page.context().cookies(expected.origin);
      if (!cookies.some((cookie) => cookie.name === "d2lSessionVal" && Boolean(cookie.value))) return false;
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
