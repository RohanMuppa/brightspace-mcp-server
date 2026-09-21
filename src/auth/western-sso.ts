/** Western University login entry point. Licensed under MIT; see LICENSE. */

import type { Page } from "playwright";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { UnsupportedAuthenticationError } from "./sso-flow.js";

const WESTERN_HOST = "westernu.brightspace.com";

export function isWesternBrightspace(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === WESTERN_HOST;
  } catch {
    return false;
  }
}

/** Reuse the shared credential and MFA flow; only Western's first click differs. */
export class WesternSSOFlow {
  private readonly common: PurdueSSOFlow;

  constructor(config: ConstructorParameters<typeof PurdueSSOFlow>[0]) {
    this.common = new PurdueSSOFlow(config);
  }

  hasCredentials(): boolean {
    return this.common.hasCredentials();
  }

  async prepareLogin(page: Page): Promise<void> {
    await this.startWesternLogin(page);
  }

  async identifyAccount(page: Page): Promise<boolean> {
    return this.common.identifyAccount(page);
  }

  async login(page: Page): Promise<boolean> {
    await this.startWesternLogin(page);
    return this.common.login(page);
  }

  private async startWesternLogin(page: Page): Promise<void> {
    let current: URL;
    try {
      current = new URL(page.url());
    } catch {
      return;
    }
    if (current.hostname.toLowerCase() !== WESTERN_HOST || !current.pathname.includes("/d2l/login")) return;

    const button = page.getByRole("button", { name: "Log in with your Western account" }).first();
    if (!await button.isVisible().catch(() => false)) {
      throw new UnsupportedAuthenticationError("Western University's Brightspace sign-in button is unavailable.");
    }
    await button.click();
  }
}
