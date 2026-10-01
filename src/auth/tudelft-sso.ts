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
// Give the login page time to settle after submission before trusting any
// alert banner as a rejection: a 1 second margin, or two polls, whichever a
// given test/runtime environment can observe.
const REJECTION_SETTLE_MS = 1_000;
const REJECTION_SETTLE_POLLS = 2;
const REJECTION_TEXT_PATTERN = /invalid|incorrect|rejected|wrong|failed|onjuist|ongeldig/i;

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

/**
 * Only a specific error container counts as a rejection on its own. A bare
 * `[role="alert"]` is also common for benign, standing banners (maintenance
 * notices, cookie prompts) that have nothing to do with the credentials just
 * submitted, so it only counts when its text reads like a rejection.
 */
async function findRejectionAlert(page: Page): Promise<Locator | null> {
  const specific = await firstVisible(page, ['.form-error', '.login-error', '.alert-danger', '#error', '[role="alert"].error']);
  if (specific) return specific;

  const generic = await firstVisible(page, ['[role="alert"]']);
  if (generic) {
    const text = (await generic.textContent().catch(() => null)) ?? "";
    if (REJECTION_TEXT_PATTERN.test(text)) return generic;
  }
  return null;
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
    let submittedAt: number | null = null;
    let pollsSinceSubmit = 0;
    let consentSubmitted = false;
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;

    try {
      do {
        let current: URL;
        try {
          current = new URL(page.url());
        } catch {
          // Not a parseable URL (e.g. a transient navigation state). Give it
          // another poll instead of treating it as a fatal unknown host.
          await page.waitForTimeout(250);
          continue;
        }
        if (current.protocol !== "https:" && current.protocol !== "http:") {
          // about:blank and similar interstitial pages show up between
          // navigations; they're not an identity-provider page to evaluate.
          await page.waitForTimeout(250);
          continue;
        }

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
              submittedAt = Date.now();
            }
          } else {
            pollsSinceSubmit++;
            const settled = pollsSinceSubmit >= REJECTION_SETTLE_POLLS
              || (submittedAt !== null && Date.now() - submittedAt >= REJECTION_SETTLE_MS);
            // Recheck the host: the alert lookup is async and must not act on
            // a page that has since navigated away from NetID.
            if (settled && isNetID(new URL(page.url())) && await findRejectionAlert(page)) {
              throw new UnsupportedAuthenticationError("TU Delft NetID sign-in was rejected. Check the saved NetID and password.");
            }
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
