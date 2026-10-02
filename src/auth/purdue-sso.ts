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
import { DuoMfaHandler } from "./duo-mfa.js";
import { AUTH_COMMAND } from "../utils/commands.js";
import type { RememberMfaOutcome, RememberMfaResult } from "./microsoft-session.js";

// Entra names its username field type=email/loginfmt; Shibboleth portals (USC's
// login.usc.edu among them) use the protocol's j_username.
const EMAIL_SELECTORS = ["input[type=email]", "input[name=loginfmt]", "input[name=j_username]", "input#signinid"];
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

/**
 * Entra's "Don't ask again for N days" checkbox: the number-match page's id
 * first, then the verification-code page's, then the label text for a tenant
 * that renames both. "Stay signed in?" only keeps the session; this box is
 * what lets the tenant skip the second factor, and the page navigates the
 * instant the phone approves, so it is ticked before the challenge is
 * announced or a code is asked for.
 */
const REMEMBER_MFA_SELECTORS = ["#idChkBx_SAOTCAS_TD", "#idChkBx_SAOTCC_TD"];
const REMEMBER_MFA_LABEL = /don.t ask again/i;
const REMEMBER_MFA_LOG: Record<RememberMfaOutcome, string> = {
  ticked: "ticked",
  already: "already checked",
  absent: "not offered by tenant",
  unknown: "could not be ticked",
  off: "off (set D2L_REMEMBER_MFA=true to tick it)",
};

/** How often to look for the number while waiting on MFA. */
const NUMBER_MATCH_POLL_MS = 2000;

/** A person has to find their phone, unlock it, and read a prompt. */
const MFA_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Entra's number-match request itself expires (typically ~1-2 minutes) well
 * before the 5-minute MFA_TIMEOUT_MS this flow allows overall, or the user
 * can tap Deny. Either way Entra stops showing the number and offers a way to
 * send another request; without asking for one this flow just polls a dead
 * request until MFA_TIMEOUT_MS. Bounded so a tenant that never clears this
 * screen still hits the ordinary timeout instead of resending forever.
 */
const MAX_RESENDS = 2;

/**
 * EXPECTED, not verified against a live tenant from here: Entra's "Send
 * another request" control on the number-match timeout/denied view.
 * Matched by id first because it is far more specific than the text fallback
 * below. Entra's own title ids for this view — `#idDiv_SAASTO_Title` for a
 * timeout, `#idDiv_SAASDS_Title` for a denial — are not matched directly
 * since this id is the more stable target, but are left here as a breadcrumb
 * for whoever next has a live tenant to confirm these against.
 */
const RESEND_ID_SELECTOR = "#idA_SAASTO_Resend";

/**
 * EXPECTED, not observed: a fallback for when Entra renames the id above.
 * Any visible control whose text reads as a resend action, scoped to the
 * sign-in surface (never the whole document, which can contain unrelated
 * matches).
 */
const RESEND_TEXT_PATTERN = /send another request|resend notification|try again|send again/i;

/**
 * Never click a control offering to switch verification methods — that
 * abandons number-match for something this headless flow cannot complete.
 */
const RESEND_SWITCH_METHOD_PATTERN = /can.t use|sign in another way|different verification|other ways/i;

/** Where the text-based resend fallback is allowed to look. */
const RESEND_SCOPE_SELECTORS = ["#lightbox", "form"];

/** Log once, not on every poll, when no resend control turns up after a number vanishes. */
const RESEND_NOT_FOUND_WARN_MS = 30_000;

/**
 * Don't click the resend control again on the immediately following poll —
 * give Entra a full cycle to re-render before looking again. Two poll
 * intervals rather than one so ordinary per-poll overhead can never make the
 * elapsed time creep past a single interval and defeat the guard.
 */
const RESEND_CLICK_GUARD_MS = NUMBER_MATCH_POLL_MS * 2;

interface PurdueSSOConfig {
  username?: string;
  password?: string;
  baseUrl?: string;
  headless?: boolean;
  requestMfaCode?: RequestMfaCode;
  /** Tick Entra's "Don't ask again" box on the MFA page. Opt-in: only true (D2L_REMEMBER_MFA=true) ticks it. */
  rememberMfa?: boolean;
  /**
   * Fired as soon as an MFA challenge is visible: with the number-match
   * digits when one is already on screen, otherwise null. Fired again, with
   * the new digits, every time a DIFFERENT number replaces the one last
   * announced — including after Entra's number-match request expires or is
   * denied and this flow asks it to send another one (see MAX_RESENDS below).
   * Lets a caller (AuthRunner) answer the user immediately instead of
   * blocking for the whole 5-minute approval wait, even on tenants that
   * never show a number, and re-answer if the number it already gave the
   * user has since gone stale.
   */
  onMfaChallenge?: (number: string | null) => void;
}

/** Microsoft expects Purdue's full sign-in name, while setup also accepts a career account. */
function signInName(username: string, baseUrl?: string): string {
  const isPurdue = baseUrl && new URL(baseUrl).hostname.toLowerCase() === "purdue.brightspace.com";
  return isPurdue && !username.includes("@") ? `${username}@purdue.edu` : username;
}

export class PurdueSSOFlow {
  private config: PurdueSSOConfig;
  private accountHintSubmitted = false;
  /** One authenticator code per login. See submitMfaCode. */
  private mfaCodeSubmitted = false;
  /** Set once per login, the first time Entra's MFA page is handled. */
  private rememberMfa: RememberMfaResult | undefined;
  private readonly duoMfa: DuoMfaHandler;

  constructor(config: PurdueSSOConfig) {
    this.config = config;
    this.duoMfa = new DuoMfaHandler(config);
  }

  /**
   * Returns true if credentials are available for automated SSO login.
   */
  hasCredentials(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  /** What Entra's "Don't ask again" checkbox did, once its MFA page has appeared. */
  rememberMfaResult(): RememberMfaResult | undefined {
    return this.rememberMfa;
  }

  async prepareLogin(page: Page): Promise<void> {
    await this.handleCampusSelector(page);
  }

  /** First half of Brightspace Bar's choreography, with no password access. */
  async identifyAccount(page: Page): Promise<boolean> {
    if (!this.config.username) return false;
    const email = signInName(this.config.username, this.config.baseUrl);
    if (!await this.fillWhenReady(page, EMAIL_SELECTORS, email)) return false;
    // Reached via awaitSilentSSO, a single-page IdP (see enterCredentials)
    // renders its password field next to the username too. Clicking submit
    // without filling it first would post an empty password and burn the
    // attempt, so detect and handle it here the same way.
    if (this.config.password && await this.hasCoVisiblePassword(page)) {
      if (!await this.fillWhenReady(page, PASSWORD_SELECTORS, this.config.password)) return false;
    }
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
      const postCredential = await this.hasPostCredentialChallenge(page);
      const kmsi = await page.getByText("Stay signed in?").first().isVisible().catch(() => false);
      if (!page.url().includes("/d2l/home") && !postCredential && !kmsi) await this.enterCredentials(page);

      // Wait for device approval and print Microsoft's number match.
      await this.handleMFA(page);

      return true;
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new UnsupportedAuthenticationError("The identity provider could not complete automatic sign-in. Check saved credentials and supported MFA settings.", error as Error);
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
    // A submitted account hint only counts once Microsoft has actually left the
    // email step. It keeps that field on screen whenever it rejects the hint,
    // and clickWhenReady swallows a click that never landed on purpose (Entra
    // normally detaches the button after navigating), so identifyAccount can
    // report a success the page never granted. Skipping the email step there
    // spends the whole password timeout on a page still asking for a username
    // and then blames a missing password field.
    const hintAccepted = this.accountHintSubmitted && !await this.anyVisible(page, EMAIL_SELECTORS);
    this.accountHintSubmitted = false;
    // Microsoft can also know the account without a hint from this login: a
    // remembered account's passwordless approval view, once awaitSilentSSO
    // takes "Use your password instead", leads to a password page with no
    // username field at all.
    if (!hintAccepted && !await this.isPasswordOnlyPage(page)) {
      const email = signInName(this.config.username, this.config.baseUrl);
      if (!await this.fillWhenReady(page, EMAIL_SELECTORS, email)) {
        throw new UnsupportedAuthenticationError("The identity provider's username field did not appear. Automatic sign-in cannot continue.");
      }
      // A single-page identity provider (Shibboleth portals such as USC's
      // login.usc.edu) renders the password field next to the username. Clicking
      // submit between the two would post an empty password and spend the
      // attempt, so fill both and click once. Entra can also flash a
      // password-shaped decoy for a single instant while its email view is
      // still initializing (see awaitSilentSSO's passwordPromptPolls in
      // browser-auth.ts), so this only takes the single-page branch once the
      // field survives two consecutive checks.
      if (await this.hasCoVisiblePassword(page)) {
        if (!await this.fillWhenReady(page, PASSWORD_SELECTORS, this.config.password)) {
          throw new UnsupportedAuthenticationError("The identity provider's password field did not appear. Automatic sign-in cannot continue.");
        }
        if (!await this.clickWhenReady(page, SUBMIT_SELECTORS)) {
          throw new UnsupportedAuthenticationError("The identity provider's submit button did not appear. Automatic sign-in cannot continue.");
        }
        return;
      }
      if (!await this.clickWhenReady(page, SUBMIT_SELECTORS)) {
        throw new UnsupportedAuthenticationError("The identity provider's username submit button did not appear. Automatic sign-in cannot continue.");
      }
    }
    if (!await this.fillWhenReady(page, PASSWORD_SELECTORS, this.config.password)) {
      throw new UnsupportedAuthenticationError("The identity provider's password field did not appear. Automatic sign-in cannot continue.");
    }
    if (!await this.clickWhenReady(page, SUBMIT_SELECTORS)) {
      throw new UnsupportedAuthenticationError("The identity provider's password submit button did not appear. Automatic sign-in cannot continue.");
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

  /**
   * True only when the password field is visible on two consecutive checks.
   * Entra can transiently show a password-shaped control for a single
   * instant while its email view is still initializing (documented next to
   * awaitSilentSSO's `passwordPromptPolls` in browser-auth.ts); trusting one
   * instantaneous observation can fill that decoy and click Next, leaving
   * Entra's real password page never filled. A genuinely single-page IdP
   * (Shibboleth portals such as USC's login.usc.edu) keeps the field on
   * screen, so it survives the second check.
   */
  private async hasCoVisiblePassword(page: Page): Promise<boolean> {
    if (!await this.anyVisible(page, PASSWORD_SELECTORS)) return false;
    await page.waitForTimeout(FIELD_POLL_MS);
    return await this.anyVisible(page, PASSWORD_SELECTORS);
  }

  /** A stable password field with no username field beside it. */
  private async isPasswordOnlyPage(page: Page): Promise<boolean> {
    return await this.hasCoVisiblePassword(page) && !await this.anyVisible(page, EMAIL_SELECTORS);
  }

  private async hasPostCredentialChallenge(page: Page): Promise<boolean> {
    return this.duoMfa.isChallenge(page) || await this.anyVisible(page, [
      NUMBER_MATCH_SELECTOR,
      "#idDiv_SAOTCAS_Title",
      "#idDiv_SAOTCC_Title",
      "#KmsiCheckboxField",
    ]);
  }

  /** Brightspace Bar's bounded number/auth/KMSI polling loop. */
  private async handleMFA(page: Page): Promise<void> {
    if (!this.config.baseUrl) {
      throw new UnsupportedAuthenticationError("A school URL is required to verify authentication.");
    }
    const deadline = Date.now() + MFA_TIMEOUT_MS;
    let challenged = false;
    let announced: string | null = null;
    /** True once onMfaChallenge has been told about this login, number or not. */
    let announcedToCaller = false;
    /**
     * The last number actually handed to onMfaChallenge. Distinct from
     * `announced` (which only dedupes the WARN log): once the caller has been
     * told about a number, a later DIFFERENT one — including a numberless
     * announcement's first number — must reach onMfaChallenge again, even
     * though `announced` already fires the log every time it changes.
     */
    let lastAnnouncedNumber: string | null = null;
    /** True once a number has appeared at least once this login (Fix 2 below only reacts after one has). */
    let sawNumber = false;
    let resendCount = 0;
    let resendLastClickAt: number | null = null;
    let numberVanishedAt: number | null = null;
    let resendNotFoundWarned = false;
    try {
      while (Date.now() < deadline) {
        // A verified session outranks whatever challenge controls linger on
        // screen: answering them would prompt or announce for nothing.
        if (await this.isAuthenticated(page)) {
          log("INFO", "Login successful - verified Brightspace home");
          return;
        }
        if (await this.duoMfa.handle(page)) challenged = true;
        if (await this.submitMfaCode(page)) challenged = true;
        const number = await this.readNumberMatch(page);
        if (number) sawNumber = true;
        const challengeVisible = number !== null ||
          await page.locator("#idDiv_SAOTCAS_Title").first().isVisible().catch(() => false) ||
          await page.locator("#idDiv_SAOTCC_Title").first().isVisible().catch(() => false);
        if (challengeVisible && !challenged) {
          await this.rememberMfaDevice(page);
          challenged = true;
          log("WARN", "Waiting up to 5 minutes for Microsoft MFA approval on your device.");
          this.config.onMfaChallenge?.(number);
          announcedToCaller = true;
          lastAnnouncedNumber = number;
        }
        if (number && number !== announced) {
          announced = number;
          log("WARN", `Number match: ${number}. Enter it in Microsoft Authenticator.`);
          if (!announcedToCaller || number !== lastAnnouncedNumber) {
            announcedToCaller = true;
            lastAnnouncedNumber = number;
            this.config.onMfaChallenge?.(number);
          }
        }
        if (number) {
          numberVanishedAt = null;
          resendNotFoundWarned = false;
        }
        // Fix 2: Entra's number-match request itself times out (or the user
        // taps Deny) well before the 5-minute budget above. Once that has
        // happened, ask Entra for another one instead of polling a dead
        // request until MFA_TIMEOUT_MS; readNumberMatch on the next poll
        // picks up the fresh number, and the re-announce logic above tells
        // the caller about it.
        if (sawNumber && number === null && new URL(page.url()).hostname === "login.microsoftonline.com") {
          if (numberVanishedAt === null) numberVanishedAt = Date.now();
          resendNotFoundWarned = await this.tryResendNumberMatch(page, {
            resendCount,
            resendLastClickAt,
            numberVanishedAt,
            resendNotFoundWarned,
            onResend: (clickedAt) => {
              resendCount += 1;
              resendLastClickAt = clickedAt;
            },
          });
        }
        await this.clickProvenKmsi(page);
        // The federated-domain trust prompt arrives after the IdP succeeds, so
        // it has to be caught by this loop rather than by enterCredentials.
        await this.clickTrustPrompt(page);
        await page.waitForTimeout(NUMBER_MATCH_POLL_MS);
      }
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      if (challenged) throw new MfaApprovalError(error as Error, announced ?? undefined);
      throw new UnsupportedAuthenticationError("Automatic sign-in stopped before a supported MFA challenge completed.", error as Error);
    }
    if (challenged) throw new MfaApprovalError(undefined, announced ?? undefined);
    throw new UnsupportedAuthenticationError("Sign-in did not reach a supported MFA challenge or Brightspace within 5 minutes.");
  }

  /**
   * Look for Entra's "send another request" affordance and click it, at most
   * MAX_RESENDS times per login and never twice in immediate succession.
   * Returns the (possibly updated) resendNotFoundWarned flag for the caller
   * to carry into the next poll.
   */
  private async tryResendNumberMatch(
    page: Page,
    state: {
      resendCount: number;
      resendLastClickAt: number | null;
      numberVanishedAt: number;
      resendNotFoundWarned: boolean;
      onResend: (clickedAt: number) => void;
    },
  ): Promise<boolean> {
    if (state.resendCount >= MAX_RESENDS) return state.resendNotFoundWarned;
    if (state.resendLastClickAt !== null && Date.now() - state.resendLastClickAt < RESEND_CLICK_GUARD_MS) {
      return state.resendNotFoundWarned;
    }
    const control = await this.findResendControl(page);
    if (!control) {
      if (!state.resendNotFoundWarned && Date.now() - state.numberVanishedAt >= RESEND_NOT_FOUND_WARN_MS) {
        log("WARN", "Number-match request appears to have expired or been denied, but no \"send another request\" control was found; continuing to wait.");
        return true;
      }
      return state.resendNotFoundWarned;
    }
    const clickedAt = Date.now();
    state.onResend(clickedAt);
    log("WARN", `Number-match request expired; sent another request (${state.resendCount + 1} of ${MAX_RESENDS}).`);
    await control.click().catch(() => {});
    return state.resendNotFoundWarned;
  }

  /** Entra's resend control, matched by id first, then by a scoped text fallback. See the selector constants' own comments. */
  private async findResendControl(page: Page): Promise<Locator | null> {
    const byId = page.locator(RESEND_ID_SELECTOR).first();
    if (await byId.isVisible().catch(() => false)) return byId;

    for (const scopeSelector of RESEND_SCOPE_SELECTORS) {
      const scope = page.locator(scopeSelector).first();
      if (!await scope.isVisible().catch(() => false)) continue;
      const candidates = await scope.getByText(RESEND_TEXT_PATTERN).all().catch(() => []);
      for (const candidate of candidates) {
        if (!await candidate.isVisible().catch(() => false)) continue;
        const text = (await candidate.textContent().catch(() => null)) ?? "";
        if (RESEND_SWITCH_METHOD_PATTERN.test(text)) continue;
        return candidate;
      }
    }
    return null;
  }

  private async submitMfaCode(page: Page): Promise<boolean> {
    const input = await this.firstVisible(page, MFA_CODE_SELECTORS);
    if (!input) return false;
    if (this.config.headless === false) return false;
    // Ask once per login. This runs on every two-second poll, and Microsoft
    // commonly leaves the field on screen while it validates, so without this
    // a correct code gets a second prompt on the next tick. That prompt blocks
    // on stdin, and the deadline is only checked between iterations, so the
    // five-minute budget can never fire while parked there.
    if (this.mfaCodeSubmitted) return false;
    if (!this.config.requestMfaCode) {
      throw new UnsupportedAuthenticationError(
        `This MFA method requires a code. Run \`${AUTH_COMMAND}\` in a terminal to enter it.`,
      );
    }
    await this.rememberMfaDevice(page);
    this.mfaCodeSubmitted = true;
    const code = await this.config.requestMfaCode();
    if (!/^\d{6,8}$/.test(code)) throw new UnsupportedAuthenticationError("The MFA code must contain 6-8 digits.");
    await input.fill(code);
    const submit = await this.firstVisible(page, MFA_CODE_SUBMIT_SELECTORS);
    if (submit) await submit.click();
    else await input.press("Enter");
    log("INFO", "Authenticator code submitted");
    return true;
  }

  /**
   * Tick Entra's "Don't ask again" box, once per login and never in a loop.
   * Opt-in: without an explicit true the box is left alone and the outcome
   * is recorded as "off", so get_server_info can say why nothing was ticked.
   * An already-checked box is left alone so this can never untick it.
   */
  private async rememberMfaDevice(page: Page): Promise<void> {
    if (this.rememberMfa) return;
    if (this.config.rememberMfa !== true) {
      this.rememberMfa = { outcome: "off", at: new Date().toISOString() };
      log("INFO", `Entra remember-MFA checkbox: ${REMEMBER_MFA_LOG.off}`);
      return;
    }
    if (new URL(page.url()).hostname !== "login.microsoftonline.com") return;
    // A nicety, never a reason to fail sign-in: any surprise is "unknown".
    let outcome: RememberMfaOutcome;
    try {
      let box = await this.firstVisible(page, REMEMBER_MFA_SELECTORS);
      if (!box) {
        const labelled = page.getByLabel(REMEMBER_MFA_LABEL).first();
        if (await labelled.isVisible().catch(() => false)) box = labelled;
      }
      if (!box) outcome = "absent";
      else if (await box.isChecked()) outcome = "already";
      else {
        await box.check({ timeout: 5_000 });
        outcome = "ticked";
      }
    } catch {
      outcome = "unknown";
    }
    this.rememberMfa = { outcome, at: new Date().toISOString() };
    log("INFO", `Entra remember-MFA checkbox: ${REMEMBER_MFA_LOG[outcome]}`);
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

  /**
   * Microsoft asks users of a federated domain to confirm they trust it ("Do
   * you trust usc.edu?") before issuing the SAML assertion to Brightspace.
   * Nothing proceeds until Continue is clicked, and a headless run has nobody
   * to click it, so the flow parks on this page until the MFA deadline and
   * the session is never established. This dialog is an anti-login-CSRF
   * control, not a nuisance interstitial, so it is not enough to notice the
   * text is present somewhere on the page (`page.getByText()` is a whole-page
   * substring search, not a heading-scoped match) — the domain named in the
   * prompt is parsed out and compared against the domain this login is
   * actually signing into. A mismatch (e.g. the browser was steered to a
   * different tenant's confirmation) is left unclicked; the existing 5-minute
   * MFA timeout is the safe failure mode for that, same as any other
   * unhandled prompt.
   */
  private async clickTrustPrompt(page: Page): Promise<void> {
    if (new URL(page.url()).hostname !== "login.microsoftonline.com") return;
    const prompt = page.getByText(/Do you trust/i).first();
    if (!await prompt.isVisible().catch(() => false)) return;
    const text = await prompt.textContent().catch(() => null);
    const promptDomain = text ? this.extractTrustDomain(text) : null;
    const expectedDomain = this.expectedTrustDomain();
    if (!promptDomain || !expectedDomain || promptDomain !== expectedDomain) {
      log("WARN", `Domain-trust prompt named "${promptDomain ?? "an unknown domain"}", which does not match the configured sign-in domain; not confirming trust automatically.`);
      return;
    }
    const cont = page.getByRole("button", { name: /continue/i }).first();
    if (!await cont.isVisible().catch(() => false)) return;
    await cont.click().catch(() => {});
    log("INFO", `Clicked Continue on Microsoft's domain-trust prompt for ${promptDomain}.`);
  }

  /** Pulls the domain Microsoft named out of "Do you trust <domain>?" text. */
  private extractTrustDomain(text: string): string | null {
    const match = text.match(/do you trust\s+([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/i);
    return match ? match[1].toLowerCase() : null;
  }

  /** The domain this login is actually signing into, to check the trust prompt against. */
  private expectedTrustDomain(): string | null {
    if (this.config.username) {
      const email = signInName(this.config.username, this.config.baseUrl);
      const at = email.lastIndexOf("@");
      if (at !== -1) return email.slice(at + 1).toLowerCase();
    }
    // Purdue's own tenant is federated to purdue.edu regardless of what the
    // configured username looks like.
    if (this.config.baseUrl && new URL(this.config.baseUrl).hostname.toLowerCase() === "purdue.brightspace.com") {
      return "purdue.edu";
    }
    return null;
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
