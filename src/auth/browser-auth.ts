/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT: see LICENSE file for details.
 */

import type { Browser, BrowserContext, Locator, Page, Request } from "playwright";
import * as path from "node:path";
import { readFileSync, accessSync } from "node:fs";
import type { AppConfig, TokenData } from "../types/index.js";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { createSSOFlow, UnsupportedAuthenticationError, MfaApprovalError } from "./sso-flow.js";
import type { SSOFlow } from "./sso-flow.js";
import type { RequestMfaCode, OnMfaChallenge } from "./sso-flow.js";
import { isDuoPrompt } from "./duo-mfa.js";
import { BrowserStateStore, type BrowserState } from "./browser-state-store.js";
import { hasNewerEntraState, recordMicrosoftSession } from "./microsoft-session.js";
import { acquireProcessLock } from "./auth-lock.js";
import type { AuthPhase } from "./auth-phases.js";
import { AuthCooldown } from "./auth-cooldown.js";
import { mintAccessToken } from "./token-mint.js";
import { isMissingBrowserError, PLAYWRIGHT_INSTALL_HINT } from "../utils/browser-install.js";

const SILENT_SSO_TIMEOUT_MS = 30000;
const SILENT_SSO_POLL_MS = 1000;
const INITIAL_NAVIGATION_TIMEOUT_MS = 60000;
const VISIBLE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const SILENT_SSO = {
  // Kept in sync with purdue-sso.ts's EMAIL_SELECTORS: awaitSilentSSO gates on
  // this list before ever calling into that file, so a two-step Shibboleth/CAS
  // IdP whose username field only matches j_username or #signinid would never
  // get past this gate otherwise.
  emailFields: ["input[type=email]", "input[name=loginfmt]", "input[name=j_username]", "input#signinid"],
  credentialFields: ['input#username', 'input#userName', 'input[type="password"]'],
  // Entra's number match and code prompts, then CUNY Login's authenticator-code
  // field (cuny-sso.ts CUNY_TOTP_SELECTOR).
  mfaChallenges: ["#idRichContext_DisplaySign", "#idDiv_SAOTCAS_Title", "#idDiv_SAOTCC_Title", '[id="otpValue|input"]'],
  campusSaml: 'a[href*="/d2l/lp/auth/saml/initiate-login"]',
  kmsiCheckbox: "#KmsiCheckboxField",
  kmsiTitle: "Stay signed in?",
  kmsiSubmit: "#idSIButton9",
  // Microsoft's passwordless approval view ("Approve sign in request", or
  // "Request wasn't sent" once a push fails) offers the password instead. The
  // text fallback covers a tenant that renames the id.
  passwordSwitch: "#idA_PWD_SwitchToPassword",
  passwordSwitchText: "Use your password instead",
} as const;

export class BrowserAuthTransportError extends Error {
  readonly code = "AUTH_TRANSPORT";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserAuthTransportError";
  }
}

/** Non-secret identity read off a validated /users/whoami response. */
interface WhoamiIdentity {
  uniqueName?: string;
  displayName?: string;
}

export interface AuthenticateOptions {
  automatic?: boolean;
  /** Persist the token before releasing the shared authentication lock. */
  onAuthenticated?: (token: TokenData) => Promise<void>;
}

export interface BrowserAuthOptions {
  requestMfaCode?: RequestMfaCode;
  /** See PurdueSSOConfig.onMfaChallenge — fired early so a caller can answer without blocking on the full MFA wait, and again if the number changes. */
  onMfaChallenge?: OnMfaChallenge;
  /** Told how long each sign-in stage took, as it ends, whether it succeeded or not. */
  onPhase?: (phase: AuthPhase, elapsedMs: number) => void;
}

export class BrowserAuth {
  private config: AppConfig;
  private ssoFlow: SSOFlow;
  private readonly stateStore: BrowserStateStore;
  private readonly cooldown: AuthCooldown;
  private readonly onPhase?: (phase: AuthPhase, elapsedMs: number) => void;
  /** When the current login first reported an MFA challenge; splits credentials from approvalWait. */
  private challengeSeenAt: number | undefined;

  constructor(config: AppConfig, options: BrowserAuthOptions = {}) {
    this.config = config;
    this.onPhase = options.onPhase;
    const { onMfaChallenge } = options;
    this.ssoFlow = createSSOFlow(config, options.requestMfaCode, onMfaChallenge && ((number) => {
      this.challengeSeenAt ??= Date.now();
      onMfaChallenge(number);
    }));
    this.stateStore = new BrowserStateStore(config.sessionDir);
    this.cooldown = new AuthCooldown(config.sessionDir);
  }

  /** Report a stage that ran from startedAt to endedAt; a listener failure never interrupts sign-in. */
  private phaseEnded(phase: AuthPhase, startedAt: number, endedAt = Date.now()): void {
    try { this.onPhase?.(phase, endedAt - startedAt); } catch { /* Reporting must not interrupt authentication. */ }
  }

  /** Run one stage and report its duration however it ends. */
  private async timed<T>(phase: AuthPhase, work: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      this.phaseEnded(phase, startedAt);
    }
  }

  private static isWSLOrDocker(): boolean {
    try {
      if (/microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"))) return true;
    } catch { /* Not WSL. */ }
    try {
      accessSync("/.dockerenv");
      return true;
    } catch { /* Not Docker. */ }
    try {
      return /docker|containerd/.test(readFileSync("/proc/1/cgroup", "utf8"));
    } catch {
      return false;
    }
  }

  async authenticate(options: AuthenticateOptions = {}): Promise<TokenData> {
    const release = await acquireProcessLock(
      path.join(this.config.sessionDir, ".auth.lock"),
      { mode: options.automatic ? "automatic" : "explicit" },
    );
    try {
      // Even a cookie-only SAML redirect can issue an MFA push. Suppress all
      // automatic browser attempts during cooldown; HTTP token refresh runs
      // independently before this entrypoint and remains available.
      if (options.automatic) await this.cooldown.assertAllowed();
      const token = await this.attemptAuthentication();
      await options.onAuthenticated?.(token);
      await this.cooldown.clear();
      return token;
    } finally {
      await release();
    }
  }

  private async attemptAuthentication(): Promise<TokenData> {
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let listener: ((request: Request) => void) | undefined;
    let interrupted = false;
    let state: BrowserState | undefined;
    let stateSaved = false;
    let tokenStartedAt: number | undefined;
    const closeOnSignal = () => {
      interrupted = true;
      void browser?.close().catch(() => {});
    };
    try {
      state = await this.stateStore.load();
      const { chromium } = await import("playwright");
      const args = ["--disable-blink-features=AutomationControlled"];
      if (BrowserAuth.isWSLOrDocker()) args.push("--no-sandbox", "--disable-setuid-sandbox");
      // Use Playwright's own timeout, which cleans up an unsuccessful launch.
      try {
        browser = await this.timed("launch", () => chromium.launch({ headless: this.config.headless, timeout: 60000, args }));
      } catch (launchError) {
        // Keep the remedy attached to the failure. Without this the hint is
        // lost when the auth runner flattens errors into "Authentication failed".
        if (isMissingBrowserError(launchError)) {
          throw new BrowserAuthError(PLAYWRIGHT_INSTALL_HINT, "browser_missing", launchError as Error);
        }
        throw launchError;
      }
      process.once("SIGINT", closeOnSignal);
      process.once("SIGTERM", closeOnSignal);
      context = await browser.newContext({ viewport: { width: 1280, height: 720 }, storageState: state });
      page = await context.newPage();
      let captured: string | undefined;
      listener = (request) => {
        const url = new URL(request.url());
        if (url.origin !== new URL(this.config.baseUrl).origin || !url.pathname.startsWith("/d2l/")) return;
        const header = request.headers().authorization;
        if (header?.startsWith("Bearer ")) captured = header.slice(7);
      };
      page.on("request", listener);
      await this.navigateAndLogin(page);
      // Persist the verified browser state before token acquisition. Token
      // minting can fail independently, and a temporary outage must not throw
      // away newly renewed Entra or Brightspace cookies.
      await this.saveBrowserState(await context.storageState());
      stateSaved = true;
      tokenStartedAt = Date.now();
      const material = await this.harvestSessionMaterial(page, context);
      let token: TokenData | null = null;
      if (material.cookieHeader && material.csrfToken) {
        const minted = await mintAccessToken({ baseUrl: this.config.baseUrl, cookieHeader: material.cookieHeader, csrfToken: material.csrfToken });
        if (minted.ok) {
          // The mint endpoint itself carries no identity. Reuse the same
          // whoami read the other extraction strategies already validate
          // against so a mint-path login reports signedInAs too; a failure
          // here (offline, slow tenant) must not fail a login that already
          // has a good token, so it degrades to "no identity" instead.
          const identity = await this.validateToken(minted.accessToken).catch(() => null);
          token = { accessToken: minted.accessToken, capturedAt: Date.now(), expiresAt: Date.now() + this.config.tokenTtl * 1000, source: "browser", ...identity };
        } else if (minted.reason === "transport") {
          throw new BrowserAuthTransportError(`Token mint temporarily failed: ${minted.detail ?? "network unavailable"}. Saved sign-in state is preserved.`);
        } else {
          throw new BrowserAuthError("Brightspace session expired while acquiring an API token. Retry authentication.", "token_extraction");
        }
      }
      token ??= await this.tryExtractToken(page, context);
      if (!token && captured) {
        const identity = await this.validateToken(captured);
        if (identity) {
          token = { accessToken: captured, capturedAt: Date.now(), expiresAt: Date.now() + this.config.tokenTtl * 1000, source: "browser", ...identity };
        }
      }
      if (!token) throw new BrowserAuthError("Brightspace did not provide a usable API token. Saved SSO cookies have been preserved.", "token_extraction");
      if (interrupted) throw new BrowserAuthError("Authentication interrupted", "interrupted");
      log("INFO", "Browser authentication complete");
      return { ...token, ...material, tenantOrigin: new URL(this.config.baseUrl).origin };
    } catch (error) {
      if (context && !stateSaved) await this.keepNewerMicrosoftState(context, state);
      throw error;
    } finally {
      if (tokenStartedAt !== undefined) this.phaseEnded("token", tokenStartedAt);
      process.removeListener("SIGINT", closeOnSignal);
      process.removeListener("SIGTERM", closeOnSignal);
      if (page && listener) page.removeListener("request", listener);
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  /** Save the browser state and what Microsoft remembered in it. */
  private async saveBrowserState(state: BrowserState): Promise<void> {
    await this.stateStore.save(state);
    await recordMicrosoftSession(this.config.sessionDir, state, this.ssoFlow.rememberMfaResult?.())
      .catch(() => log("WARN", "Could not record the Microsoft sign-in summary; saved sign-in state is unaffected."));
  }

  /**
   * A run can fail after Entra already renewed its cookies (an MFA timeout,
   * a token-mint outage, a Brightspace redirect stall). Keep that renewal
   * when it is strictly newer than the saved jar; otherwise the saved state
   * is left untouched. Never masks the original failure.
   */
  private async keepNewerMicrosoftState(context: BrowserContext, previous: BrowserState | undefined): Promise<void> {
    try {
      const current = await context.storageState();
      if (!hasNewerEntraState(previous, current)) return;
      await this.saveBrowserState(current);
      log("INFO", "Sign-in failed, but Microsoft's renewed sign-in state was kept");
    } catch {
      log("DEBUG", "Could not keep Microsoft's renewed sign-in state after a failed sign-in");
    }
  }

  /**
   * Run the token extraction strategy chain, cheapest to most invasive.
   * Each strategy validates against /users/whoami before returning.
   * Returns null if every strategy fails.
   */
  private async tryExtractToken(
    page: Page,
    context: BrowserContext
  ): Promise<TokenData | null> {
    const build = (token: string, identity?: WhoamiIdentity | null): TokenData => {
      const now = Date.now();
      return {
        accessToken: token,
        capturedAt: now,
        expiresAt: now + this.config.tokenTtl * 1000,
        source: "browser",
        ...identity,
      };
    };

    // Strategy 0: localStorage (D2L.Fetch.Tokens) : fastest
    const lsToken = await this.extractLocalStorageToken(page);
    if (lsToken) {
      const identity = await this.validateToken(lsToken);
      if (identity) {
        log("INFO", "Extracted valid Bearer token from localStorage");
        return build(lsToken, identity);
      }
      log("WARN", "localStorage Bearer token failed validation, trying next strategy");
    }

    // Strategy 1: Force a Bearer fetch by hitting the API, then re-check localStorage
    try {
      log("DEBUG", "Navigating to API endpoint to trigger token capture");
      await page.goto(
        `${this.config.baseUrl}/d2l/api/lp/1.57/users/whoami`,
        { waitUntil: "load", timeout: 15000 }
      );
      const lsToken2 = await this.extractLocalStorageToken(page);
      if (lsToken2) {
        const identity = await this.validateToken(lsToken2);
        if (identity) {
          log("INFO", "Extracted valid Bearer token from localStorage after API nudge");
          return build(lsToken2, identity);
        }
      }
    } catch (error) {
      if (error instanceof BrowserAuthTransportError) throw error;
      log("DEBUG", "Direct API navigation did not produce Bearer token");
    }

    // Strategy 2: XSRF / page JS context
    const xsrfToken = await this.extractXsrfToken(page);
    if (xsrfToken) {
      const identity = await this.validateToken(xsrfToken);
      if (identity) {
        log("INFO", "Extracted valid XSRF token from page context");
        return build(xsrfToken, identity);
      }
      log("WARN", "XSRF token failed validation, trying next strategy");
    }

    // Strategy 3: Cookie-based auth
    const cookieToken = await this.extractCookieToken(context);
    if (cookieToken) {
      const identity = await this.validateToken(cookieToken);
      if (identity) {
        log("INFO", "Extracted valid session cookie for API auth");
        return build(cookieToken, identity);
      }
      log("WARN", "Cookie token failed validation");
    }

    return null;
  }

  /**
   * Validate a token by making a test API call to /users/whoami.
   * Returns the non-secret identity whoami reported when the token is
   * accepted by D2L (an empty object if the response carried no usable
   * name fields), or null when the token is rejected.
   */
  private async validateToken(token: string): Promise<WhoamiIdentity | null> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/d2l/api/lp/1.45/users/whoami`, {
        headers: token.startsWith("cookie:") ? { Cookie: token.slice(7) } : { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw new BrowserAuthTransportError("Token validation could not reach Brightspace.", { cause: error });
    }
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) return null;
      let user: unknown;
      try {
        user = await response.json();
      } catch (error) {
        throw new BrowserAuthTransportError("Token validation returned unreadable JSON.", { cause: error });
      }
      const whoami = user as { Identifier?: unknown; UniqueName?: unknown; DisplayName?: unknown } | null;
      const identifier = whoami?.Identifier;
      const valid = (typeof identifier === "string" && identifier.length > 0) || (typeof identifier === "number" && Number.isFinite(identifier));
      if (!valid) return null;
      return {
        ...(typeof whoami?.UniqueName === "string" && whoami.UniqueName ? { uniqueName: whoami.UniqueName } : {}),
        ...(typeof whoami?.DisplayName === "string" && whoami.DisplayName ? { displayName: whoami.DisplayName } : {}),
      };
    }
    if (response.status === 401 || response.status === 403) return null;
    throw new BrowserAuthTransportError(`Token validation temporarily failed with HTTP ${response.status}.`);
  }

  /** Restore first, and only attempt credentials after a real sign-in is needed. */
  private async navigateAndLogin(page: Page): Promise<boolean> {
    let navigationError: unknown;
    let response;
    try {
      response = await this.timed("navigation", () => page.goto(`${this.config.baseUrl}/d2l/home`, {
        waitUntil: "domcontentloaded",
        timeout: INITIAL_NAVIGATION_TIMEOUT_MS,
      }));
    } catch (error) {
      // Brightspace Bar tolerates a navigation timeout because SAML may keep
      // redirecting after Playwright stops waiting. Continue with the same
      // bounded page-state poll, but never infer that credentials are needed
      // from the navigation failure itself.
      const message = error instanceof Error ? error.message : String(error);
      if (!/timeout|ERR_ABORTED|navigation.*interrupted/i.test(message)) {
        throw new BrowserAuthTransportError("Could not reach Brightspace. Retry when the connection is available.", { cause: error });
      }
      navigationError = error;
      log("WARN", "Initial Brightspace navigation did not settle; checking the current SSO page");
    }
    if (response && (response.status() >= 500 || response.status() === 429)) {
      throw new BrowserAuthTransportError(`Brightspace temporarily returned HTTP ${response.status()}. Saved state is preserved.`);
    }
    if (await this.timed("silentSso", () => this.awaitSilentSSO(page))) {
      log("INFO", "Saved session is active");
      return true;
    }
    const pendingMfa = await this.hasMfaChallenge(page);
    const credentialPrompt = await this.hasCredentialPrompt(page);
    const hasCredentials = this.ssoFlow.hasCredentials();
    if (!hasCredentials && !pendingMfa) {
      if (this.config.headless === false) {
        await this.waitForVisibleLogin(page);
        return false;
      }
      throw new UnsupportedAuthenticationError("Automatic sign-in requires saved credentials. Run brightspace-mcp-server setup.");
    }
    if (!pendingMfa && !credentialPrompt) {
      if (this.config.headless === false) {
        await this.waitForVisibleLogin(page);
        return false;
      }
      throw new BrowserAuthTransportError(
        "The sign-in page has not settled on a supported login challenge. Retry shortly; saved state is preserved.",
        navigationError === undefined ? undefined : { cause: navigationError }
      );
    }
    const loginStartedAt = Date.now();
    this.challengeSeenAt = undefined;
    try {
      if (!await this.ssoFlow.login(page)) {
        throw new UnsupportedAuthenticationError("The identity provider could not complete automatic sign-in.");
      }
    } catch (error) {
      if (error instanceof MfaApprovalError) await this.cooldown.recordMfaFailure();
      throw error;
    } finally {
      if (this.challengeSeenAt === undefined) this.phaseEnded("credentials", loginStartedAt);
      else {
        this.phaseEnded("credentials", loginStartedAt, this.challengeSeenAt);
        this.phaseEnded("approvalWait", this.challengeSeenAt);
      }
    }
    if (!await this.hasLiveSession(page)) {
      throw new BrowserAuthError("Sign-in did not produce a verified Brightspace session.", "session_validation");
    }
    return false;
  }

  /** Keep a configured visible browser open while the user completes sign-in. */
  private async waitForVisibleLogin(page: Page): Promise<void> {
    const expected = new URL(this.config.baseUrl);
    log("INFO", "Complete sign-in and MFA in the visible browser window.");
    try {
      await page.waitForURL(
        (url) => url.origin === expected.origin && /^\/d2l\/home(?:\/|$)/.test(url.pathname),
        { timeout: VISIBLE_LOGIN_TIMEOUT_MS },
      );
    } catch (error) {
      throw new BrowserAuthError(
        "Visible sign-in did not reach Brightspace within 5 minutes.",
        "interactive_login",
        error as Error,
      );
    }

    if (!await this.hasLiveSession(page)) {
      throw new BrowserAuthError(
        "Visible sign-in reached Brightspace but did not produce a verified session.",
        "session_validation",
      );
    }
    log("INFO", "Visible browser sign-in completed.");
  }

  /**
   * Give the SSO chain a bounded window to finish with no human input.
   * Returns true only when the session proves itself live.
   */
  private async awaitSilentSSO(page: Page): Promise<boolean> {
    const deadline = Date.now() + SILENT_SSO_TIMEOUT_MS;
    let accountHintAttempted = false;
    let passwordPromptPolls = 0;
    let passwordSwitchAttempted = false;
    do {
      if (await this.hasLiveSession(page)) return true;

      // Only a visible supported challenge justifies entering credentials or
      // waiting for MFA. A stalled redirect is not proof of session expiry.
      if (await this.isAnyOnScreen(page, SILENT_SSO.emailFields)) {
        if (!accountHintAttempted && this.ssoFlow.identifyAccount) {
          accountHintAttempted = true;
          if (await this.ssoFlow.identifyAccount(page)) {
            log("DEBUG", "Submitted the configured account name to resume saved SSO");
            await page.waitForTimeout(SILENT_SSO_POLL_MS);
            continue;
          }
        }
        log("INFO", "The identity provider requires an account login");
        return false;
      }
      if (await this.hasMfaChallenge(page)) {
        log("INFO", "The identity provider requires a login challenge");
        return false;
      }
      const passwordSwitch = await this.passwordSignInOption(page);
      if (passwordSwitch) {
        // The approval view has no field or MFA title this poll recognizes, so
        // without leaving it the poll would wait out its whole budget. Switch
        // once when a password is saved; the password page then settles the
        // poll like any other credential prompt.
        if (!passwordSwitchAttempted && this.ssoFlow.hasCredentials()) {
          passwordSwitchAttempted = true;
          await passwordSwitch.click().catch(() => {});
          log("DEBUG", "Chose the password sign-in option over passwordless approval");
          await page.waitForTimeout(SILENT_SSO_POLL_MS);
          continue;
        }
        log("INFO", "The identity provider requires a password sign-in");
        return false;
      }
      if (await this.isAnyOnScreen(page, SILENT_SSO.credentialFields)) {
        passwordPromptPolls += 1;
        // Entra can briefly expose a password-shaped control while its email
        // view initializes. Brightspace Bar polls the evolving page instead of
        // concluding from that first transient snapshot.
        if (passwordPromptPolls >= 2) {
          log("INFO", "The identity provider requires a login challenge");
          return false;
        }
        await page.waitForTimeout(SILENT_SSO_POLL_MS);
        continue;
      }
      passwordPromptPolls = 0;

      try {
        await this.clickSilentSurfaces(page);
        await page.waitForTimeout(SILENT_SSO_POLL_MS);
      } catch (error) {
        if (error instanceof BrowserAuthError || error instanceof BrowserAuthTransportError) throw error;
        throw new BrowserAuthTransportError("Silent sign-in could not reach the identity provider. Saved state is preserved.", { cause: error });
      }
    } while (Date.now() < deadline);

    if (this.config.headless === false) return false;
    throw new BrowserAuthTransportError("Silent sign-in did not reach Brightspace or a supported login challenge within 30 seconds. Retry shortly; saved state is preserved.");
  }

  private async hasCredentialPrompt(page: Page): Promise<boolean> {
    return await this.isAnyOnScreen(page, SILENT_SSO.emailFields) ||
      await this.isAnyOnScreen(page, SILENT_SSO.credentialFields);
  }

  /** The visible "Use your password instead" control, when Microsoft offers one. */
  private async passwordSignInOption(page: Page): Promise<Locator | null> {
    if (await this.isOnScreen(page, SILENT_SSO.passwordSwitch)) return page.locator(SILENT_SSO.passwordSwitch).first();
    const byText = page.getByText(SILENT_SSO.passwordSwitchText).first();
    return await byText.isVisible().catch(() => false) ? byText : null;
  }

  /** One definition of the MFA pages the shared authentication loop supports. */
  private async hasMfaChallenge(page: Page): Promise<boolean> {
    return isDuoPrompt(page) || await this.isAnyOnScreen(page, SILENT_SSO.mfaChallenges);
  }

  /**
   * A POSITIVE session check, never "the URL doesn't look like a login page".
   * Institutions bounce through intermediate SAML hops with a perfectly live
   * session, and the login stub sets cookies of its own, so both the session
   * cookie and a reachable D2L JS context are required.
   */
  private async hasLiveSession(page: Page): Promise<boolean> {
    try {
      const location = new URL(page.url());
      if (location.origin !== new URL(this.config.baseUrl).origin) return false;
      // The /d2l/login shell also exposes D2L.LP and stale session cookies.
      // Only the requested authenticated home page is evidence of success.
      if (!/^\/d2l\/home(?:\/|$)/.test(location.pathname)) return false;
      const cookies = await page.context().cookies(this.config.baseUrl);
      if (!cookies.some((c) => c.name === "d2lSessionVal" && Boolean(c.value))) {
        return false;
      }
      return await page.evaluate(() => {
        const d2l = (window as unknown as Record<string, unknown>).D2L as
          | Record<string, unknown>
          | undefined;
        return d2l !== undefined && Boolean(d2l.LP);
      });
    } catch (error) {
      throw new BrowserAuthTransportError("The browser could not verify the saved Brightspace session. Saved state is preserved.", { cause: error });
    }
  }

  /**
   * Click through the two surfaces that stand between a live Entra cookie and
   * an authenticated D2L page. Neither involves a secret.
   */
  private async clickSilentSurfaces(page: Page): Promise<void> {
    const url = page.url();

    if (url.includes("/d2l/login")) {
      // The Purdue buttons are not ordinary links. Follow the school's known
      // SAML entry before deciding whether saved Microsoft state has expired.
      await this.ssoFlow.prepareLogin?.(page);
      if (!page.url().includes("/d2l/login")) return;
      // Brightspace renders the campus buttons in a shadow DOM, which
      // Playwright's selectors see through. A configured campus is matched by
      // name; otherwise the selector's own SAML link is the only affordance
      // safe to click blind, and a school that offers neither simply falls
      // through to the SSO flow, which knows its own endpoint.
      const campus = this.config.campus
        ? page.getByText(this.config.campus).first()
        : page.locator(SILENT_SSO.campusSaml).first();
      if (await campus.isVisible().catch(() => false)) {
        await campus.click().catch(() => {});
        log("DEBUG", "Clicked the campus selector");
      }
      return;
    }

    if (!url.includes("login.microsoftonline.com")) {
      await this.ssoFlow.selectIdentityProvider?.(page);
      return;
    }

    // The page must PROVE it is the "Stay signed in?" page before this click:
    // #idSIButton9 is Microsoft's id for the primary button on EVERY sign-in
    // page, "Next" on account name and "Sign in" on password, so clicking it
    // unguarded submits an empty form once a second while the log claims it
    // answered Yes. Two markers because tenant policy can hide the checkbox.
    const onKmsiPage =
      (await this.isOnScreen(page, SILENT_SSO.kmsiCheckbox)) ||
      (await page.getByText(SILENT_SSO.kmsiTitle).first().isVisible().catch(() => false));
    if (!onKmsiPage) return;

    const yes = page.locator(SILENT_SSO.kmsiSubmit).first();
    if (await yes.isVisible().catch(() => false)) {
      await yes.click().catch(() => {});
      log("DEBUG", 'Clicked Yes on "Stay signed in?"');
    }
  }

  /** Visibility without the actionability wait, so a poll keeps its rhythm. */
  private async isOnScreen(page: Page, selector: string): Promise<boolean> {
    try {
      return await page.locator(selector).first().isVisible();
    } catch (error) {
      throw new BrowserAuthTransportError("The browser could not inspect the sign-in page. Saved state is preserved.", { cause: error });
    }
  }

  /** Check each selector independently so a hidden earlier match cannot mask a visible one. */
  private async isAnyOnScreen(page: Page, selectors: readonly string[]): Promise<boolean> {
    for (const selector of selectors) {
      if (await this.isOnScreen(page, selector)) return true;
    }
    return false;
  }

  /**
   * Try to extract Bearer token from D2L's localStorage.
   * D2L stores API tokens in localStorage under "D2L.Fetch.Tokens".
   */
  private async extractLocalStorageToken(page: Page): Promise<string | null> {
    try {
      // Navigate to Brightspace home if not already there
      const currentUrl = page.url();
      if (!currentUrl.includes("/d2l/home")) {
        await page.goto(`${this.config.baseUrl}/d2l/home`, {
          waitUntil: "networkidle",
          timeout: 15000,
        });
      }

      const token = await page.evaluate(() => {
        try {
          const tokensJson = localStorage.getItem("D2L.Fetch.Tokens");
          if (!tokensJson) return null;

          const tokens = JSON.parse(tokensJson);
          // Tokens are stored as { "*:*:*": { access_token: "...", expires_at: ... } }
          const wildcardToken = tokens["*:*:*"];
          if (wildcardToken && wildcardToken.access_token) {
            return wildcardToken.access_token;
          }

          return null;
        } catch {
          return null;
        }
      });

      if (token) {
        log("DEBUG", "Found Bearer token in localStorage (D2L.Fetch.Tokens)");
        return token;
      }

      return null;
    } catch (error) {
      log("DEBUG", "localStorage token extraction failed", error);
      return null;
    }
  }

  /**
   * Harvest the material that lets the token manager mint a fresh JWT later
   * without relaunching this browser: the two D2L session cookies plus the
   * XSRF token. Best effort. A missing piece only costs the cheap refresh
   * path, so it is logged at DEBUG and the fields are left undefined.
   */
  private async harvestSessionMaterial(
    page: Page,
    context: BrowserContext
  ): Promise<{ cookieHeader?: string; csrfToken?: string }> {
    const material: { cookieHeader?: string; csrfToken?: string } = {};

    try {
      const cookies = await context.cookies(this.config.baseUrl);
      const parts: string[] = [];
      for (const name of ["d2lSessionVal", "d2lSecureSessionVal"]) {
        const found = cookies.find((c) => c.name === name);
        if (found) parts.push(`${name}=${found.value}`);
      }
      if (parts.length === 2) {
        material.cookieHeader = parts.join("; ");
      } else {
        log("DEBUG", `Session cookie harvest incomplete: found ${parts.length} of 2`);
      }
    } catch (error) {
      log("DEBUG", "Session cookie harvest failed", error);
    }

    const xsrfToken = await this.extractXsrfOnly(page);
    if (xsrfToken) {
      material.csrfToken = xsrfToken;
    } else {
      log("DEBUG", "No XSRF token harvested, later token minting is unavailable");
    }

    log(
      "DEBUG",
      `Session material harvested: cookies=${material.cookieHeader !== undefined}, xsrf=${material.csrfToken !== undefined}`
    );
    return material;
  }

  /**
   * Read the real XSRF token, and nothing else. Deliberately separate from
   * extractXsrfToken: that one falls back to a loose localStorage scan which
   * can return a JWT, and a JWT in the x-csrf-token header makes the mint 403.
   */
  private async extractXsrfOnly(page: Page): Promise<string | null> {
    try {
      // The D2L JS context only exists on a Brightspace page, and the
      // extraction chain may have parked us on a raw API response.
      if (!page.url().includes("/d2l/home")) {
        await page.goto(`${this.config.baseUrl}/d2l/home`, {
          waitUntil: "networkidle",
          timeout: 15000,
        });
      }

    } catch (error) {
      log("DEBUG", "Could not navigate to Brightspace before XSRF extraction", error);
      return null;
    }

    // Brightspace Bar retries each evaluation independently because a redirect
    // can destroy one JavaScript context while the next one is already valid.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = await page.evaluate(() => {
        const d2l = (window as unknown as Record<string, unknown>).D2L as
          | Record<string, unknown>
          | undefined;

        try {
          const lp = d2l?.LP as Record<string, unknown> | undefined;
          const web = lp?.Web as Record<string, unknown> | undefined;
          const auth = web?.Authentication as
            | Record<string, unknown>
            | undefined;
          const xsrf = auth?.Xsrf as Record<string, unknown> | undefined;
          const getToken = xsrf?.GetXsrfToken as (() => string) | undefined;
          if (getToken) {
            const value = getToken.call(xsrf);
            if (value) return value;
          }
        } catch {
          // Not available on this page
        }

        const metaToken = document.querySelector('meta[name="d2l-xsrf-token"]');
        return metaToken ? metaToken.getAttribute("content") : null;
      }).catch((error) => {
        log("DEBUG", "XSRF evaluation raced a page transition, retrying", error);
        return null;
      });
      if (token) return token;
      await page.waitForTimeout(1000);
    }
    return null;
  }

  /**
   * Try to extract XSRF/API token from D2L's JavaScript context.
   * Brightspace stores auth tokens in the page's JS globals.
   */
  private async extractXsrfToken(page: Page): Promise<string | null> {
    try {
      // Navigate back to homepage where D2L JS context is available
      const currentUrl = page.url();
      if (!currentUrl.includes("/d2l/home")) {
        await page.goto(`${this.config.baseUrl}/d2l/home`, {
          waitUntil: "networkidle",
          timeout: 15000,
        });
      }

      const token = await page.evaluate(() => {
        // D2L stores XSRF token in various places
        // Try common D2L token locations
        const d2l = (window as unknown as Record<string, unknown>).D2L as
          | Record<string, unknown>
          | undefined;

        if (d2l) {
          // Try D2L.LP.Web.Authentication.Xsrf.GetXsrfToken()
          try {
            const lp = d2l.LP as Record<string, unknown> | undefined;
            const web = lp?.Web as Record<string, unknown> | undefined;
            const auth = web?.Authentication as
              | Record<string, unknown>
              | undefined;
            const xsrf = auth?.Xsrf as Record<string, unknown> | undefined;
            const getToken = xsrf?.GetXsrfToken as (() => string) | undefined;
            if (getToken) return getToken.call(xsrf);
          } catch {
            // Not available
          }
        }

        // Try extracting from meta tags or script data
        const metaToken = document.querySelector(
          'meta[name="d2l-xsrf-token"]'
        );
        if (metaToken) return metaToken.getAttribute("content");

        // Try extracting from local storage
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.includes("token") || key.includes("Token"))) {
            const val = localStorage.getItem(key);
            if (val && val.length > 20) return val;
          }
        }

        return null;
      });

      if (token) {
        log("DEBUG", "Found token via page JavaScript context");
        return token;
      }

      return null;
    } catch (error) {
      log("DEBUG", "XSRF token extraction failed", error);
      return null;
    }
  }

  /**
   * Extract D2L session cookies that can be used for cookie-based API auth.
   * Constructs a cookie header string from d2lSessionVal and d2lSecureSessionVal.
   */
  private async extractCookieToken(
    context: BrowserContext
  ): Promise<string | null> {
    try {
      const cookies = await context.cookies(this.config.baseUrl);
      const relevantCookies = cookies.filter(
        (c) =>
          c.name === "d2lSessionVal" ||
          c.name === "d2lSecureSessionVal" ||
          c.name.startsWith("d2l")
      );

      if (relevantCookies.length === 0) {
        log("DEBUG", "No D2L session cookies found");
        return null;
      }

      // Build a cookie string for API requests
      const cookieStr = relevantCookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      log(
        "DEBUG",
        `Found ${relevantCookies.length} D2L cookies: ${relevantCookies.map((c) => c.name).join(", ")}`
      );
      return `cookie:${cookieStr}`;
    } catch (error) {
      log("DEBUG", "Cookie extraction failed", error);
      return null;
    }
  }

}
