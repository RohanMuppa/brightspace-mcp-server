/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT : see LICENSE file for details.
 */

import type { Page } from "playwright";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { log } from "../utils/logger.js";
import { UnsupportedAuthenticationError } from "./sso-flow.js";
import type { RequestMfaCode } from "./sso-flow.js";

/** SUNY campuses share one Brightspace tenant behind one Shibboleth IdP. */
const SUNY_BRIGHTSPACE_HOST = "mylearning.suny.edu";
const SUNY_IDP_ENTITY_ID = "https://idm.suny.edu/shibboleth/idp/";
const SUNY_IDM_HOST = "idm.suny.edu";

const SELECTORS = {
  campusSelect: "select#campus",
  campusSubmit: '#selectionForm button[type="submit"]',
} as const;

interface SunySSOConfig {
  username?: string;
  password?: string;
  /** Campus name or numeric code, matched against SUNY's own dropdown. */
  campus?: string;
  headless?: boolean;
  requestMfaCode?: RequestMfaCode;
}

interface CampusOption {
  value: string;
  label: string;
}

/** True for the shared SUNY Brightspace instance. */
export function isSunyBrightspace(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === SUNY_BRIGHTSPACE_HOST;
  } catch {
    return false;
  }
}

/**
 * SUNY carries its own hostname inside the redirect parameters it round-trips,
 * so compare the host rather than searching the whole URL.
 */
function isSunyIdp(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === SUNY_IDM_HOST;
  } catch {
    return false;
  }
}

/**
 * Login flow for the shared SUNY Brightspace instance.
 *
 * SUNY puts two extra pages in front of the campus identity provider: the
 * Brightspace campus selector, whose buttons sit in a shadow DOM, and SUNY's
 * own campus dropdown at idm.suny.edu. This handler clears both, then hands
 * off to the default flow, which already knows the Shibboleth, CAS, and
 * Microsoft Entra sign-in forms the individual campuses use.
 */
export class SunySSOFlow {
  private config: SunySSOConfig;
  private defaultFlow: PurdueSSOFlow;

  constructor(config: SunySSOConfig) {
    this.config = config;
    this.defaultFlow = new PurdueSSOFlow({
      username: config.username,
      password: config.password,
      baseUrl: `https://${SUNY_BRIGHTSPACE_HOST}`,
      headless: config.headless,
      requestMfaCode: config.requestMfaCode,
    });
  }

  hasCredentials(): boolean {
    return this.defaultFlow.hasCredentials();
  }

  async prepareLogin(page: Page): Promise<void> {
    await this.startSamlLogin(page);
    await this.selectCampus(page);
  }

  async identifyAccount(page: Page): Promise<boolean> {
    return this.defaultFlow.identifyAccount(page);
  }

  async login(page: Page): Promise<boolean> {
    try {
      await this.startSamlLogin(page);
      await this.selectCampus(page);
    } catch (error) {
      throw new UnsupportedAuthenticationError("SUNY campus selection could not complete headlessly. Run brightspace-mcp-server setup --suny and select a campus.", error as Error);
    }
    return this.defaultFlow.login(page);
  }

  /**
   * Brightspace's own campus selector renders its buttons in a shadow DOM, so
   * go straight to the SAML endpoint that selector would have reached.
   */
  private async startSamlLogin(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (!currentUrl.includes("/d2l/login")) return;

    const origin = new URL(currentUrl).origin;
    log("INFO", "Campus selector detected : navigating directly to SUNY's SAML endpoint");
    await page.goto(
      `${origin}/d2l/lp/auth/saml/initiate-login?entityId=${SUNY_IDP_ENTITY_ID}`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
  }

  /**
   * Answer SUNY's "Select Campus" dropdown. Without a configured campus the
   * page is left for the user, who is already at the browser for MFA.
   */
  private async selectCampus(page: Page): Promise<void> {
    if (!isSunyIdp(page.url())) return;

    try {
      // idm.suny.edu sits behind a bot check, so the form can take a few
      // seconds to appear even on a fast connection.
      await page.waitForSelector(SELECTORS.campusSelect, { timeout: 45000 });
    } catch {
      log("DEBUG", "No SUNY campus dropdown found : continuing to the sign-in form");
      return;
    }

    const options = await page.$$eval(`${SELECTORS.campusSelect} option`, (nodes) =>
      nodes
        .map((node) => ({
          value: (node as HTMLOptionElement).value,
          label: (node.textContent ?? "").trim(),
        }))
        .filter((option) => option.value !== "")
    );

    if (!this.config.campus) {
      throw new UnsupportedAuthenticationError("No SUNY campus configured. Run brightspace-mcp-server setup --suny.");
    }

    const match = this.findCampus(options);
    if (!match) {
      throw new UnsupportedAuthenticationError(`Configured campus did not match SUNY. Available campuses: ${options.map((o) => o.label).join(", ")}`);
    }

    log("INFO", `Selecting campus ${match.label} (${match.value})`);
    await page.selectOption(SELECTORS.campusSelect, match.value);
    await page.click(SELECTORS.campusSubmit);
  }

  /**
   * Resolve the configured campus against SUNY's live option list, so no copy
   * of the campus table has to be kept in this repo. Matches a numeric code or
   * a campus name, exactly first and then as a prefix.
   */
  private findCampus(options: CampusOption[]): CampusOption | undefined {
    const wanted = this.config.campus?.trim().toLowerCase();
    if (!wanted) return undefined;

    return (
      options.find((option) => option.value.toLowerCase() === wanted) ??
      options.find((option) => option.label.toLowerCase() === wanted) ??
      options.find((option) => option.label.toLowerCase().startsWith(wanted))
    );
  }
}
