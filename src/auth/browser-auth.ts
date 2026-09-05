/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Playwright is imported lazily inside launchBrowserWithRetry. Loading it at
// module top costs about 200 ms on every server start, including the common
// case where the stored session is valid and no browser is ever launched.
import type { BrowserContext, Page } from "playwright";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { AppConfig, TokenData } from "../types/index.js";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { createSSOFlow } from "./sso-flow.js";
import type { SSOFlow } from "./sso-flow.js";

/**
 * The silent-SSO budget. When the D2L session is dead but the Microsoft Entra
 * cookie in the persistent profile is still alive, the SSO chain completes on
 * its own within a few seconds, provided the two no-secret surfaces in its way
 * get clicked. A URL check cannot see any of that, so the wait is a poll on a
 * positive session check instead.
 */
const SILENT_SSO_TIMEOUT_MS = 30000;
const SILENT_SSO_POLL_MS = 1000;

const SILENT_SSO = {
  /** Entra asking who you are. No amount of silent waiting passes it. */
  emailField: "input[type=email], input[name=loginfmt]",
  /** The Brightspace campus selector's own link to the SAML endpoint. */
  campusSaml: 'a[href*="/d2l/lp/auth/saml/initiate-login"]',
  /** Markers unique to the "Stay signed in?" page. */
  kmsiCheckbox: "#KmsiCheckboxField",
  kmsiTitle: "Stay signed in?",
  kmsiSubmit: "#idSIButton9",
} as const;

/**
 * Thrown when a headless run reaches the point where a human has to see the
 * screen. Not a failure: the caller relaunches the browser visible and retries.
 */
export class HeadlessLoginRequiredError extends Error {
  constructor() {
    super("A sign-in is needed and the browser must be visible for it");
    this.name = "HeadlessLoginRequiredError";
  }
}

/** Whether the current attempt has to start over with a window on screen. */
export function needsVisibleBrowser({ launchedHeadless }: { launchedHeadless: boolean }): boolean {
  return launchedHeadless;
}

export class BrowserAuth {
  private config: AppConfig;
  private ssoFlow: SSOFlow;
  /** Whether the browser for the current attempt was launched without a window. */
  private launchedHeadless = false;

  constructor(config: AppConfig) {
    this.config = config;
    this.ssoFlow = createSSOFlow(config);
  }

  /**
   * Detect if running inside WSL (Windows Subsystem for Linux) or Docker.
   * These environments require --no-sandbox for Chromium to launch.
   */
  private static isWSLOrDocker(): boolean {
    try {
      // WSL: /proc/version contains "microsoft" or "WSL"
      const procVersion = require("node:fs").readFileSync("/proc/version", "utf-8");
      if (/microsoft|wsl/i.test(procVersion)) return true;
    } catch {
      // Not Linux or /proc not available
    }
    try {
      // Docker: /.dockerenv exists or /proc/1/cgroup contains "docker"
      require("node:fs").accessSync("/.dockerenv");
      return true;
    } catch {
      // Not Docker
    }
    try {
      const cgroup = require("node:fs").readFileSync("/proc/1/cgroup", "utf-8");
      if (cgroup.includes("docker") || cgroup.includes("containerd")) return true;
    } catch {
      // Not in a container
    }
    return false;
  }

  /**
   * Build Chromium launch args based on the current platform and environment.
   */
  private static buildChromiumArgs(): string[] {
    const args = ["--disable-blink-features=AutomationControlled"];

    if (process.platform === "win32") {
      args.push("--disable-gpu");
    }

    // On macOS, NSPersistentUIRestorer is disabled via `defaults write` in
    // applyMacOSCrashGuard() — see issue #10. Passing "-ApplePersistenceIgnoreState YES"
    // as argv doesn't work here because Playwright's launchPersistentContext rejects
    // non-flag positional arguments.

    if (BrowserAuth.isWSLOrDocker()) {
      args.push("--no-sandbox", "--disable-setuid-sandbox");
      log("INFO", "Detected WSL/Docker environment — launching Chromium with --no-sandbox");
    }

    return args;
  }

  /**
   * Prevent Chrome for Testing from SIGTRAP'ing on launch on macOS (issue #10).
   *
   * Three layers, all idempotent and cheap:
   *   1. ApplePersistenceIgnoreState — disables NSPersistentUIRestorer's crash-prompt
   *      modal, which Chrome for Testing's AppKit bridge cannot handle.
   *   2. IIO_LaunchInfo=0 — resets LaunchServices' per-app crash counter so macOS
   *      stops triggering the recovery pathway in the first place.
   *   3. Nuke the Cocoa saved-application-state bundle — if it exists, AppKit tries
   *      to replay window state during launch and can crash the browser process.
   *
   * Runs before every launch. None of these are destructive to user data; Chrome
   * for Testing is a disposable test profile.
   */
  private static async applyMacOSCrashGuard(): Promise<void> {
    if (process.platform !== "darwin") return;

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    try {
      await execFileAsync("defaults", [
        "write",
        "com.google.chrome.for.testing",
        "ApplePersistenceIgnoreState",
        "-bool",
        "yes",
      ]);
    } catch {
      // Non-fatal
    }

    try {
      await execFileAsync("defaults", [
        "write",
        "com.google.chrome.for.testing",
        "IIO_LaunchInfo",
        "-int",
        "0",
      ]);
    } catch {
      // Non-fatal
    }

    try {
      const savedState = path.join(
        os.homedir(),
        "Library",
        "Saved Application State",
        "com.google.chrome.for.testing.savedState"
      );
      await fs.rm(savedState, { recursive: true, force: true });
    } catch {
      // Non-fatal
    }

    log("DEBUG", "Applied macOS crash guards for Chrome for Testing");
  }

  /**
   * Recovery step: the current browser-data profile is corrupted in a way that
   * makes Chromium SIGTRAP during launch (issue #10). Move it aside so the next
   * launch attempt gets a clean profile. Cheap — user just re-authenticates.
   */
  private async quarantineBrowserDataDir(browserDataDir: string): Promise<void> {
    try {
      const stamp = Date.now();
      const quarantined = `${browserDataDir}.corrupted.${stamp}`;
      await fs.rename(browserDataDir, quarantined);
      log(
        "WARN",
        `Quarantined corrupted browser profile to ${quarantined} — starting fresh`
      );
    } catch (error) {
      // If rename fails (permissions, missing dir), try a recursive delete instead.
      try {
        await fs.rm(browserDataDir, { recursive: true, force: true });
        log("WARN", "Deleted corrupted browser profile — starting fresh");
      } catch (rmError) {
        log("WARN", "Failed to quarantine browser profile", rmError);
      }
    }
  }

  /**
   * Authenticate, opening a window if the flow turns out to need one.
   *
   * Headless is only ever safe for the silent path. The moment a real sign-in
   * is required the run starts over with a visible browser, because the MFA
   * number match has to be readable by a human.
   */
  async authenticate(): Promise<TokenData> {
    try {
      return await this.attemptAuthentication(this.config.headless);
    } catch (error) {
      if (error instanceof HeadlessLoginRequiredError) {
        log("INFO", "A sign-in is needed, so the browser is reopening with a window");
        return await this.attemptAuthentication(false);
      }
      throw error;
    }
  }

  private async attemptAuthentication(preferHeadless: boolean): Promise<TokenData> {
    let context: BrowserContext | null = null;

    try {
      log("INFO", "Starting browser authentication");

      await BrowserAuth.applyMacOSCrashGuard();

      const mkdirOpts: { recursive: true; mode?: number } = { recursive: true };
      if (process.platform !== "win32") {
        mkdirOpts.mode = 0o700;
      }
      await fs.mkdir(this.config.sessionDir, mkdirOpts);

      const browserDataDir = path.join(this.config.sessionDir, "browser-data");

      // Remove stale Chromium lock files that can block persistent context launch.
      // On Windows, if the browser is killed by antivirus or force-closed, these
      // lock files persist and prevent all future auth attempts.
      await this.validateAndClearLockFiles(browserDataDir);

      // Force headed mode when no credentials — user must interact with the browser
      const headless = this.ssoFlow.hasCredentials() ? preferHeadless : false;
      if (!this.ssoFlow.hasCredentials() && preferHeadless) {
        log("INFO", "Overriding headless mode — browser must be visible for manual login");
      }
      this.launchedHeadless = headless;

      const launchOptions = {
        headless,
        viewport: { width: 1280, height: 720 } as const,
        args: BrowserAuth.buildChromiumArgs(),
        timeout: 60000,
      };

      context = await this.launchBrowserWithRetry(browserDataDir, launchOptions);

      log("INFO", "Browser context launched");

      // If the user Ctrl+C's while Chrome is running, Node tears down the
      // subprocess with SIGKILL — Chrome writes "Crashed" to exit_type, the
      // LaunchServices crash counter ticks up, and the next launch can SIGTRAP.
      // Hook SIGINT/SIGTERM so we close the context gracefully first. See issue #10.
      const contextRef = context;
      const cleanShutdown = async (signal: NodeJS.Signals) => {
        log("WARN", `Received ${signal} — closing browser cleanly`);
        try {
          await contextRef.close();
        } catch {
          // Already closing
        }
        process.exit(130);
      };
      process.once("SIGINT", cleanShutdown);
      process.once("SIGTERM", cleanShutdown);

      // Load saved storage state if it exists (cookies + localStorage)
      // This works around Playwright bug #36139 where session cookies don't persist
      await this.loadStorageState(context);

      const page = context.pages()[0] || (await context.newPage());

      // CRITICAL: Set up token interception BEFORE navigation
      // Use longer timeout for manual login (5 min) vs automated SSO (2 min)
      const interceptTimeout = this.ssoFlow.hasCredentials() ? 120000 : 300000;
      const tokenPromise = this.setupTokenInterception(page, interceptTimeout);

      // Navigate and login if needed
      const alreadyAuthenticated = await this.navigateAndLogin(page);

      // Run the extraction strategy chain on BOTH paths. Modern Brightspace's
      // /d2l/home uses cookie auth and emits no Bearer header, so the passive
      // interceptor never fires on a fresh manual login — the chain rescues
      // us via localStorage instead. See issue #10.
      log("INFO", alreadyAuthenticated
        ? "Session cookies active — trying to extract API token"
        : "Login complete — extracting API token from session");

      const extracted = await this.tryExtractToken(page, context);
      if (extracted) {
        const material = await this.harvestSessionMaterial(page, context);
        await this.saveStorageState(context);
        log("INFO", "Authentication complete");
        return { ...extracted, ...material };
      }

      // Last resort for the cookie-restore path: clear cookies, force full
      // re-login through SSO, and race the passive listener as a final fallback.
      if (alreadyAuthenticated) {
        log("WARN", "Could not extract valid token from existing session, forcing re-login");
        await context.clearCookies();
        await page.close();
        const freshPage = await context.newPage();
        const freshTokenPromise = this.setupTokenInterception(freshPage);
        await this.navigateAndLogin(freshPage);

        const freshExtracted = await this.tryExtractToken(freshPage, context);
        if (freshExtracted) {
          const material = await this.harvestSessionMaterial(freshPage, context);
          await this.saveStorageState(context);
          log("INFO", "Authentication complete");
          return { ...freshExtracted, ...material };
        }

        const accessToken = await freshTokenPromise;
        log("INFO", "Bearer token captured after forced re-login");
        const now = Date.now();
        const tokenData: TokenData = {
          accessToken,
          capturedAt: now,
          expiresAt: now + this.config.tokenTtl * 1000,
          source: "browser",
          ...(await this.harvestSessionMaterial(freshPage, context)),
        };
        await this.saveStorageState(context);
        return tokenData;
      }

      // Fresh-login final fallback: wait on the passive listener.
      // Rarely reached in practice — tryExtractToken typically hits localStorage first.
      log("INFO", "Waiting for Bearer token from network interception");
      const accessToken = await tokenPromise;
      log("INFO", "Bearer token captured successfully");

      const now = Date.now();
      const tokenData: TokenData = {
        accessToken,
        capturedAt: now,
        expiresAt: now + this.config.tokenTtl * 1000,
        source: "browser",
        ...(await this.harvestSessionMaterial(page, context)),
      };

      await this.saveStorageState(context);
      log("INFO", "Authentication complete");
      return tokenData;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log("ERROR", "Browser authentication failed", error);

      // Provide platform-specific troubleshooting hints
      let hint = "";
      if (process.platform === "win32") {
        if (errMsg.includes("Target page, context or browser has been closed")) {
          hint = " (Windows hint: antivirus or firewall may be closing the browser. Try adding Chromium to your exclusion list.)";
        } else if (errMsg.includes("EPERM") || errMsg.includes("EACCES")) {
          hint = " (Windows hint: try running as Administrator, or check that no other process has locked the session directory.)";
        } else if (errMsg.includes("Timeout") || errMsg.includes("timeout")) {
          hint = " (Windows hint: browser launch timed out. Close all Chromium/Chrome instances in Task Manager and try again. Antivirus may also be blocking the launch.)";
        }
      }
      if (BrowserAuth.isWSLOrDocker() && (errMsg.includes("spawn") || errMsg.includes("ENOENT") || errMsg.includes("sandbox"))) {
        hint = " (WSL/Docker hint: ensure Chromium dependencies are installed. Run: npx playwright install-deps chromium)";
      }

      throw new BrowserAuthError(
        `Authentication failed${hint}`,
        "authenticate",
        error as Error
      );
    } finally {
      if (context) {
        log("DEBUG", "Closing browser context");
        try {
          await context.close();
        } catch (closeError) {
          // Context may already be closed (e.g. browser crashed or was closed externally).
          // This is common on Windows where the browser process can terminate unexpectedly.
          log("DEBUG", "Browser context already closed or failed to close", closeError);
        }
      }
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
    const build = (token: string): TokenData => {
      const now = Date.now();
      return {
        accessToken: token,
        capturedAt: now,
        expiresAt: now + this.config.tokenTtl * 1000,
        source: "browser",
      };
    };

    // Strategy 0: localStorage (D2L.Fetch.Tokens) — fastest
    const lsToken = await this.extractLocalStorageToken(page);
    if (lsToken && (await this.validateToken(lsToken))) {
      log("INFO", "Extracted valid Bearer token from localStorage");
      return build(lsToken);
    }
    if (lsToken) log("WARN", "localStorage Bearer token failed validation, trying next strategy");

    // Strategy 1: Force a Bearer fetch by hitting the API, then re-check localStorage
    try {
      log("DEBUG", "Navigating to API endpoint to trigger token capture");
      await page.goto(
        `${this.config.baseUrl}/d2l/api/lp/1.57/users/whoami`,
        { waitUntil: "load", timeout: 15000 }
      );
      const lsToken2 = await this.extractLocalStorageToken(page);
      if (lsToken2 && (await this.validateToken(lsToken2))) {
        log("INFO", "Extracted valid Bearer token from localStorage after API nudge");
        return build(lsToken2);
      }
    } catch {
      log("DEBUG", "Direct API navigation did not produce Bearer token");
    }

    // Strategy 2: XSRF / page JS context
    const xsrfToken = await this.extractXsrfToken(page);
    if (xsrfToken && (await this.validateToken(xsrfToken))) {
      log("INFO", "Extracted valid XSRF token from page context");
      return build(xsrfToken);
    }
    if (xsrfToken) log("WARN", "XSRF token failed validation, trying next strategy");

    // Strategy 3: Cookie-based auth
    const cookieToken = await this.extractCookieToken(context);
    if (cookieToken && (await this.validateToken(cookieToken))) {
      log("INFO", "Extracted valid session cookie for API auth");
      return build(cookieToken);
    }
    if (cookieToken) log("WARN", "Cookie token failed validation");

    return null;
  }

  /**
   * Validate a token by making a test API call to /users/whoami.
   * Returns true if the token is accepted by D2L, false otherwise.
   */
  private async validateToken(token: string): Promise<boolean> {
    try {
      const headers: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      };

      if (token.startsWith("cookie:")) {
        headers["Cookie"] = token.substring(7);
      } else {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const response = await fetch(
        `${this.config.baseUrl}/d2l/api/lp/1.45/users/whoami`,
        {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(10000),
        }
      );

      if (response.ok) {
        log("DEBUG", "Token validation succeeded (whoami returned 200)");
        return true;
      }

      log("DEBUG", `Token validation failed: HTTP ${response.status}`);
      return false;
    } catch (error) {
      log("DEBUG", "Token validation error", error);
      return false;
    }
  }

  /**
   * Set up passive network request listener to capture Bearer token.
   * MUST be called BEFORE page.goto() to avoid race condition.
   */
  private setupTokenInterception(page: Page, timeoutMs = 120000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new BrowserAuthError(
            `Token interception timed out after ${timeoutMs / 1000} seconds`,
            "token_interception"
          )
        );
      }, timeoutMs);

      page.on("request", (request) => {
        const url = request.url();

        // Look for any request with a Bearer token
        if (url.includes("/d2l/")) {
          const authHeader = request.headers()["authorization"];

          if (authHeader && authHeader.startsWith("Bearer ")) {
            const token = authHeader.substring("Bearer ".length);
            log("DEBUG", `Token captured from request to ${url}`);
            clearTimeout(timeout);
            resolve(token);
          }
        }
      });

      log("DEBUG", "Token interception listener registered");
    });
  }

  /**
   * Navigate to Brightspace and login if needed.
   * Returns true if already authenticated (cookies valid), false if SSO login was performed.
   */
  private async navigateAndLogin(page: Page): Promise<boolean> {
    try {
      log("INFO", `Navigating to ${this.config.baseUrl}/d2l/home`);
      await page.goto(`${this.config.baseUrl}/d2l/home`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      if (await this.awaitSilentSSO(page)) {
        log("INFO", "Already authenticated - skipping SSO login");
        await this.settle(page);
        return true;
      }

      // A credential login on Entra ends in a number match: two digits on the
      // page that the human types into Authenticator. Headless has nowhere to
      // show them, so the login would time out with the number sitting in a
      // log file. Bail out and let authenticate() relaunch with a window.
      if (needsVisibleBrowser({ launchedHeadless: this.launchedHeadless })) {
        throw new HeadlessLoginRequiredError();
      }

      let loginSuccess: boolean;

      if (this.ssoFlow.hasCredentials()) {
        log("INFO", `Login required (stopped at ${page.url()}) - starting SSO flow`);
        loginSuccess = await this.ssoFlow.login(page);

        if (!loginSuccess) {
          log("WARN", "Automated SSO flow failed or timed out. Falling back to manual login.");
          log("INFO", "Please complete the login manually in the open browser window.");
          loginSuccess = await this.ssoFlow.manualLogin(page);
        }
      } else {
        log("INFO", `Login required (stopped at ${page.url()}) - opening browser for manual login`);
        loginSuccess = await this.ssoFlow.manualLogin(page);
      }

      if (!loginSuccess) {
        throw new BrowserAuthError("Manual login flow failed", "manual_login");
      }

      await this.settle(page);
      return false;
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new BrowserAuthError(
        "Failed to navigate and login",
        "navigate_login",
        error as Error
      );
    }
  }

  /** Let the page finish loading, without letting a slow one fail the run. */
  private async settle(page: Page): Promise<void> {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    } catch {
      log("DEBUG", "Page wait timed out, proceeding anyway");
    }
  }

  /**
   * Give the SSO chain a bounded window to finish with no human input.
   * Returns true only when the session proves itself live.
   */
  private async awaitSilentSSO(page: Page): Promise<boolean> {
    const deadline = Date.now() + SILENT_SSO_TIMEOUT_MS;
    do {
      if (await this.hasLiveSession(page)) return true;

      // Fail fast rather than spend the budget on a page that will never
      // advance: a fresh profile otherwise stalls here for the full 30s.
      if (await this.isOnScreen(page, SILENT_SSO.emailField)) {
        log("INFO", "Silent SSO cannot pass an account-name prompt - a credential login is needed");
        return false;
      }

      await this.clickSilentSurfaces(page);
      await page.waitForTimeout(SILENT_SSO_POLL_MS);
    } while (Date.now() < deadline);

    log("DEBUG", `No session after ${SILENT_SSO_TIMEOUT_MS / 1000}s of silent SSO`);
    return false;
  }

  /**
   * A POSITIVE session check, never "the URL doesn't look like a login page".
   * Institutions bounce through intermediate SAML hops with a perfectly live
   * session, and the login stub sets cookies of its own, so both the session
   * cookie and a reachable D2L JS context are required.
   */
  private async hasLiveSession(page: Page): Promise<boolean> {
    try {
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
    } catch {
      return false;
    }
  }

  /**
   * Click through the two surfaces that stand between a live Entra cookie and
   * an authenticated D2L page. Neither involves a secret.
   */
  private async clickSilentSurfaces(page: Page): Promise<void> {
    const url = page.url();

    if (url.includes("/d2l/login")) {
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

    if (!url.includes("login.microsoftonline.com")) return;

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
    return page.locator(selector).first().isVisible().catch(() => false);
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

      return await page.evaluate(() => {
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
            const value = getToken();
            if (value) return value;
          }
        } catch {
          // Not available on this page
        }

        const metaToken = document.querySelector('meta[name="d2l-xsrf-token"]');
        return metaToken ? metaToken.getAttribute("content") : null;
      });
    } catch (error) {
      log("DEBUG", "XSRF-only extraction failed", error);
      return null;
    }
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
            if (getToken) return getToken();
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

  /**
   * Load previously saved storage state (cookies + localStorage).
   * Workaround for Playwright bug #36139: session cookies don't persist in persistent context.
   */
  private async loadStorageState(context: BrowserContext): Promise<void> {
    try {
      const storageStatePath = path.join(
        this.config.sessionDir,
        "storage-state.json"
      );

      // Check if storage state file exists
      let stats: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stats = await fs.stat(storageStatePath);
      } catch {
        log("DEBUG", "No existing storage state to load");
        return;
      }

      // Skip loading stale cookies that would fake "already authenticated"
      const ageMs = Date.now() - stats.mtimeMs;
      const maxAgeMs = this.config.tokenTtl * 1000;
      if (ageMs > maxAgeMs) {
        log("INFO", `Storage state is ${Math.round(ageMs / 60000)}min old (TTL ${this.config.tokenTtl}s) — skipping stale cookies`);
        return;
      }

      // Read storage state
      const stateJson = await fs.readFile(storageStatePath, "utf-8");
      const state = JSON.parse(stateJson) as {
        cookies: Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          expires: number;
          httpOnly: boolean;
          secure: boolean;
          sameSite: "Strict" | "Lax" | "None";
        }>;
        origins: Array<{
          origin: string;
          localStorage: Array<{ name: string; value: string }>;
        }>;
      };

      // Restore cookies
      if (state.cookies && state.cookies.length > 0) {
        await context.addCookies(state.cookies);
        log(
          "INFO",
          `Restored ${state.cookies.length} cookies from storage state`
        );
      }

      // Restore localStorage for each origin
      if (state.origins && state.origins.length > 0) {
        for (const origin of state.origins) {
          if (origin.localStorage && origin.localStorage.length > 0) {
            let tempPage: Page | null = null;
            try {
              // Create a temporary page to set localStorage
              tempPage = await context.newPage();
              await tempPage.goto(origin.origin, { timeout: 10000 });

              // Set each localStorage item
              await tempPage.evaluate((items) => {
                for (const item of items) {
                  localStorage.setItem(item.name, item.value);
                }
              }, origin.localStorage);

              log(
                "INFO",
                `Restored ${origin.localStorage.length} localStorage items for ${origin.origin}`
              );
            } catch (originError) {
              log("WARN", `Failed to restore localStorage for ${origin.origin}`, originError);
            } finally {
              if (tempPage) {
                try {
                  await tempPage.close();
                } catch {
                  // Page may already be closed
                }
              }
            }
          }
        }
      }

      log("INFO", "Storage state restored successfully");
    } catch (error) {
      log("WARN", "Failed to load storage state", error);
    }
  }

  private async saveStorageState(context: BrowserContext): Promise<void> {
    try {
      const storageStatePath = path.join(
        this.config.sessionDir,
        "storage-state.json"
      );
      await context.storageState({ path: storageStatePath });
      await fs.chmod(storageStatePath, 0o600);
      log("DEBUG", `Storage state saved to ${storageStatePath}`);
    } catch (error) {
      log("WARN", "Failed to save storage state", error);
    }
  }

  /**
   * Launch browser with retry logic.
   * Windows is prone to 180s launch timeouts (Playwright issue #22117) caused by
   * lingering Chromium processes, antivirus interference, or resource contention.
   * On timeout, we clear lock files and retry once.
   */
  private async launchBrowserWithRetry(
    browserDataDir: string,
    options: {
      headless: boolean;
      viewport: { readonly width: number; readonly height: number };
      args: string[];
      timeout: number;
    }
  ): Promise<BrowserContext> {
    // The only place the browser is needed, so the only place it is loaded.
    const { chromium } = await import("playwright");

    // Validate lock files before every launch attempt
    await this.validateAndClearLockFiles(browserDataDir);

    try {
      // Wrap in Promise.race so a hung launch (e.g. stale SingletonLock
      // that wasn't caught) still falls into the retry path
      const launchPromise = chromium.launchPersistentContext(browserDataDir, options);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout: browser launch hung")), options.timeout)
      );
      return await Promise.race([launchPromise, timeoutPromise]);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const isTimeout = errMsg.includes("Timeout") || errMsg.includes("timeout") || errMsg.includes("hung");

      // macOS: Chrome for Testing died during launch with SIGTRAP / browser
      // closed. The profile is likely corrupted from prior crashes. Quarantine
      // it, reapply the crash guards, and retry with a fresh profile.
      // See issue #10.
      const isMacBrowserCrash =
        process.platform === "darwin" &&
        (errMsg.includes("Target page, context or browser has been closed") ||
          errMsg.includes("SIGTRAP") ||
          errMsg.includes("did exit"));

      if (isMacBrowserCrash) {
        log(
          "WARN",
          "Chrome for Testing crashed during launch — quarantining profile and retrying"
        );
        await this.quarantineBrowserDataDir(browserDataDir);
        await BrowserAuth.applyMacOSCrashGuard();
        return await chromium.launchPersistentContext(browserDataDir, {
          ...options,
          timeout: 90000,
        });
      }

      if (isTimeout) {
        log("WARN", "Browser launch timed out — clearing lock files and retrying");
        await this.validateAndClearLockFiles(browserDataDir);
        return await chromium.launchPersistentContext(browserDataDir, {
          ...options,
          timeout: 90000,
        });
      }

      throw error;
    }
  }

  /**
   * Validate and remove stale Chromium lock files from the browser data directory.
   * Playwright's persistent context uses Chromium's SingletonLock mechanism.
   * If the browser is killed unexpectedly (antivirus, force close, crash),
   * these lock files persist and block all future launch attempts.
   *
   * For SingletonLock (a symlink whose target is "hostname-pid"), we check
   * whether the owning process is still alive before removing it. This avoids
   * deleting a lock held by a legitimate running instance.
   */
  private async validateAndClearLockFiles(browserDataDir: string): Promise<void> {
    // Ensure the directory exists before scanning
    try {
      await fs.access(browserDataDir);
    } catch {
      return; // Directory doesn't exist yet, nothing to clean
    }

    const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
    for (const lockFile of lockFiles) {
      const lockPath = path.join(browserDataDir, lockFile);
      try {
        const stat = await fs.lstat(lockPath);

        if (stat.isSymbolicLink() && lockFile === "SingletonLock") {
          // SingletonLock is a symlink with target "hostname-pid"
          const target = await fs.readlink(lockPath);
          const dashIdx = target.lastIndexOf("-");
          if (dashIdx > 0) {
            const lockHostname = target.substring(0, dashIdx);
            const lockPid = parseInt(target.substring(dashIdx + 1), 10);

            if (lockHostname !== os.hostname()) {
              // Lock from a different machine (e.g. NFS home dir, or stale after network change)
              log("WARN", `Removing SingletonLock from different host (${lockHostname} vs ${os.hostname()})`);
              await fs.unlink(lockPath);
              continue;
            }

            if (!isNaN(lockPid)) {
              try {
                process.kill(lockPid, 0); // Signal 0 checks if process exists
                // Process is alive, leave the lock alone
                log("DEBUG", `SingletonLock held by live process ${lockPid}, skipping`);
                continue;
              } catch (killErr: unknown) {
                const code = (killErr as NodeJS.ErrnoException).code;
                if (code === "ESRCH") {
                  // Process is dead, safe to remove
                  log("WARN", `Removing SingletonLock from dead process ${lockPid}`);
                  await fs.unlink(lockPath);
                  continue;
                }
                if (code === "EPERM") {
                  // Process exists but we lack permissions, leave it alone
                  log("DEBUG", `SingletonLock held by process ${lockPid} (EPERM), skipping`);
                  continue;
                }
              }
            }
          }

          // Could not parse target, remove as a safety measure
          log("WARN", `Removing unparseable SingletonLock: ${target}`);
          await fs.unlink(lockPath);
        } else {
          // Regular file (SingletonCookie, SingletonSocket) or unknown symlink
          await fs.unlink(lockPath);
          log("WARN", `Removed stale lock file: ${lockFile}`);
        }
      } catch {
        // File doesn't exist, expected in normal operation
      }
    }
  }
}
