/** TU Delft NetID login via SURFconext. Licensed under MIT; see LICENSE. */

import type { Locator, Page } from "playwright";
import type { SSOFlow } from "./sso-flow.js";
import { UnsupportedAuthenticationError } from "./sso-flow.js";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

const BRIGHTSPACE_HOST = "brightspace.tudelft.nl";
const NETID_HOST = "login.tudelft.nl";
const SURFCONEXT_HOST = "engine.surfconext.nl";
const LOGIN_TIMEOUT_MS = 60_000;

interface TUDelftSSOConfig {
  username?: string;
  password?: string;
}

export function isTUDelftBrightspace(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === BRIGHTSPACE_HOST;
  } catch {
    return false;
  }
}

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

function isNetID(url: URL): boolean {
  return url.protocol === "https:" && url.hostname.toLowerCase() === NETID_HOST;
}

/** NetID uses a simultaneous username/password form and normally requires no MFA. */
export class TUDelftSSOFlow implements SSOFlow {
  constructor(private readonly config: TUDelftSSOConfig) {}

  hasCredentials(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  async login(page: Page): Promise<boolean> {
    if (!this.hasCredentials()) return false;
    log("INFO", "Starting TU Delft NetID sign-in");
    let submitted = false;
    let consentSubmitted = false;
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;

    try {
      do {
        const current = new URL(page.url());
        if (current.origin === `https://${BRIGHTSPACE_HOST}` && /^\/d2l\/home(?:\/|$)/.test(current.pathname)) {
          return true;
        }

        if (isNetID(current)) {
          if (!submitted) {
            const username = await firstVisible(page, ['input#username', 'input[name="username"]', 'input[name="j_username"]']);
            const password = await firstVisible(page, ['input#password', 'input[name="password"]', 'input[name="j_password"]']);
            const submit = await firstVisible(page, ['#submit_button', 'button[name="_eventId_proceed"]', 'button[type="submit"]', 'input[type="submit"]']);
            if (username && password && submit) {
              await username.fill(this.config.username!);
              // Recheck after the account field: a navigation must never send
              // the password to a different origin using a stale locator.
              if (!isNetID(new URL(page.url()))) {
                throw new UnsupportedAuthenticationError("TU Delft sign-in left the trusted NetID page before password entry.");
              }
              await password.fill(this.config.password!);
              await submit.click();
              submitted = true;
            }
          } else if (await firstVisible(page, ['[role="alert"]', '.form-error', '.login-error'])) {
            throw new UnsupportedAuthenticationError("TU Delft NetID sign-in was rejected. Check the saved NetID and password.");
          }
        } else if (current.protocol === "https:" && current.hostname.toLowerCase() === SURFCONEXT_HOST) {
          // A user's first visit may require consent to share information with
          // Brightspace. No credentials are entered on SURFconext itself.
          if (!consentSubmitted) {
            const consent = await firstVisible(page, ['#consent_accept', 'button[name="confirm"]', 'input[name="confirm"]', 'input[name="yes"]']);
            if (consent) {
              await consent.click();
              consentSubmitted = true;
            }
          }
        } else if (current.origin !== `https://${BRIGHTSPACE_HOST}`) {
          throw new UnsupportedAuthenticationError("TU Delft sign-in reached an unsupported identity-provider page. No credentials were entered there.");
        }
        await page.waitForTimeout(250);
      } while (Date.now() < deadline);
      throw new UnsupportedAuthenticationError("TU Delft NetID sign-in did not reach Brightspace within 60 seconds. Check the saved credentials or retry with D2L_HEADLESS=false for an interactive sign-in.");
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new UnsupportedAuthenticationError("TU Delft NetID sign-in could not complete automatically.", error as Error);
    }
  }
}
