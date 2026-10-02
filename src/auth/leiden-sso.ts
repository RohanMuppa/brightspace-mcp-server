/** Leiden University login via SURFconext and Microsoft Entra. Licensed under MIT; see LICENSE. */

import type { Page } from "playwright";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { UnsupportedAuthenticationError } from "./sso-flow.js";
import type { RememberMfaResult } from "./microsoft-session.js";
import { log } from "../utils/logger.js";

const LEIDEN_HOST = "brightspace.universiteitleiden.nl";
const SURFCONEXT_HOST = "engine.surfconext.nl";
// SURFconext lists eduID first and LUMC next to Leiden, so the account is
// picked by entity ID rather than by position or a "Leiden" text match.
export const LEIDEN_ENTRA_ENTITY_ID = "https://sts.windows.net/ca2a7f76-dbd7-4ec0-9108-6b3d524fb7c8/";
// The list wrapper never reports as visible, so the search box marks the picker.
const WAYF_SEARCH = "#wayf_search";
const LEIDEN_WAYF_ENTRY = `.wayf__idp[data-entityid="${LEIDEN_ENTRA_ENTITY_ID}"]`;

export function isLeidenBrightspace(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === LEIDEN_HOST;
  } catch {
    return false;
  }
}

function isSurfconext(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname.toLowerCase() === SURFCONEXT_HOST;
  } catch {
    return false;
  }
}

/**
 * Brightspace sends Leiden users straight to SURFconext's account picker.
 * Choosing the Entra entry there is the only Leiden-specific step; the
 * Microsoft sign-in after it is the shared flow.
 */
export class LeidenSSOFlow {
  private readonly common: PurdueSSOFlow;

  constructor(config: ConstructorParameters<typeof PurdueSSOFlow>[0]) {
    this.common = new PurdueSSOFlow(config);
  }

  hasCredentials(): boolean {
    return this.common.hasCredentials();
  }

  rememberMfaResult(): RememberMfaResult | undefined {
    return this.common.rememberMfaResult();
  }

  async selectIdentityProvider(page: Page): Promise<void> {
    await this.chooseLeidenAccount(page);
  }

  async identifyAccount(page: Page): Promise<boolean> {
    return this.common.identifyAccount(page);
  }

  async login(page: Page): Promise<boolean> {
    await this.chooseLeidenAccount(page);
    return this.common.login(page);
  }

  private async chooseLeidenAccount(page: Page): Promise<void> {
    if (!isSurfconext(page.url())) return;
    // The redirect back to Brightspace also passes through SURFconext.
    if (!await page.locator(WAYF_SEARCH).first().isVisible().catch(() => false)) return;

    const entry = page.locator(LEIDEN_WAYF_ENTRY).first();
    if (!await entry.isVisible().catch(() => false)) {
      throw new UnsupportedAuthenticationError("SURFconext no longer offers the Leiden University (Entra) account. Sign in with D2L_HEADLESS=false and pick the account manually.");
    }
    log("INFO", "Choosing Leiden University (Entra) on SURFconext");
    await entry.click();
  }
}
