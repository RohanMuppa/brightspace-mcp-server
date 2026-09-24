import type { Locator, Page } from "playwright";
import { log } from "../utils/logger.js";
import { AUTH_COMMAND } from "../utils/commands.js";
import { UnsupportedAuthenticationError } from "./sso-flow.js";
import type { RequestMfaCode } from "./sso-flow.js";

/** Duo's verified-push digits: three to six, per Duo's push-verification policy. */
const VERIFICATION_CODE_PATTERN = /^\d{3,6}$/;

/**
 * Duo renders the verified-push digits in an element of its own. Read that
 * element rather than the document at large: an unscoped
 * page.getByText(/^\d{3,6}$/) matches ANY standalone three-to-six digit text on
 * the page — a masked phone number's last four, a countdown, a "remembered for
 * 30 days" line — and .first() then announces whichever one the DOM happened to
 * render first. A headless run has no screen to check that against, so the
 * wrong number is simply typed into Duo Mobile and the push is denied.
 */
const VERIFICATION_CODE_SELECTORS = [
  ".verification-code",
  "#verification-code",
  "[class*='verification-code']",
];

/**
 * Duo's prompt surface, innermost first, bounding the fallback text scan for
 * the day Duo renames the element above. The first one on screen decides:
 * numbers rendered outside Duo's own prompt are not the code.
 */
const PROMPT_SCOPE_SELECTORS = [
  "#auth-view",
  ".base-wrapper",
  "#root",
  "#app",
  "main",
  "body",
];

interface DuoMfaOptions {
  headless?: boolean;
  requestMfaCode?: RequestMfaCode;
  /** See PurdueSSOConfig.onMfaChallenge — same one-shot-plus-late-number contract. */
  onMfaChallenge?: (number: string | null) => void;
}

/** The digits on a visible element, or null when it is absent or not digits. */
async function readCodeFrom(target: Locator): Promise<string | null> {
  if (!await target.isVisible().catch(() => false)) return null;
  const code = (await target.textContent().catch(() => null))?.trim();
  return code && VERIFICATION_CODE_PATTERN.test(code) ? code : null;
}

/** Duo Universal Prompt redirects to a Duo-hosted page after primary sign-in. */
export function isDuoPrompt(page: Page): boolean {
  try {
    const host = new URL(page.url()).hostname.toLowerCase();
    return host === "duosecurity.com" || host.endsWith(".duosecurity.com");
  } catch {
    return false;
  }
}

/** Handle the Duo-specific parts of an otherwise school-independent MFA loop. */
export class DuoMfaHandler {
  private approvalAnnounced = false;
  private verificationCodeAnnounced: string | null = null;
  private passcodeSubmitted = false;
  /** True once onMfaChallenge has been told about this login, code or not. */
  private announcedToCaller = false;

  constructor(private readonly options: DuoMfaOptions) {}

  isChallenge(page: Page): boolean {
    return isDuoPrompt(page);
  }

  /** Returns true while the page is on a Duo challenge. */
  async handle(page: Page): Promise<boolean> {
    if (!this.isChallenge(page)) return false;

    const verificationCode = await this.readVerificationCode(page);

    if (!this.approvalAnnounced) {
      this.approvalAnnounced = true;
      log("WARN", "Waiting up to 5 minutes for Duo MFA approval on your device.");
      this.options.onMfaChallenge?.(verificationCode);
      if (verificationCode) this.announcedToCaller = true;
    }

    if (verificationCode && verificationCode !== this.verificationCodeAnnounced) {
      this.verificationCodeAnnounced = verificationCode;
      log("WARN", `Duo verification code: ${verificationCode}. Enter it in Duo Mobile.`);
      if (!this.announcedToCaller) {
        this.announcedToCaller = true;
        this.options.onMfaChallenge?.(verificationCode);
      }
    }

    await this.submitPasscode(page);
    return true;
  }

  private async readVerificationCode(page: Page): Promise<string | null> {
    return await this.readCodeElement(page) ?? await this.readScopedCode(page);
  }

  /** Duo's own verification-code element, when the prompt exposes one. */
  private async readCodeElement(page: Page): Promise<string | null> {
    for (const selector of VERIFICATION_CODE_SELECTORS) {
      const code = await readCodeFrom(page.locator(selector).first());
      if (code) return code;
    }
    return null;
  }

  /**
   * Fallback for a prompt that does not label its digits: the standalone
   * numbers inside Duo's prompt container. Announce one only when they all
   * agree — two different numbers mean this is not a screen this can read, and
   * naming the wrong one costs the user the push.
   */
  private async readScopedCode(page: Page): Promise<string | null> {
    for (const selector of PROMPT_SCOPE_SELECTORS) {
      const scope = page.locator(selector).first();
      if (!await scope.isVisible().catch(() => false)) continue;
      const found: string[] = [];
      const candidates = await scope.getByText(VERIFICATION_CODE_PATTERN).all().catch(() => []);
      for (const candidate of candidates) {
        // Nested elements repeat the same text; only distinct values compete.
        const code = await readCodeFrom(candidate);
        if (code && !found.includes(code)) found.push(code);
      }
      if (found.length > 1) {
        log("DEBUG", `Duo prompt showed ${found.length} standalone numbers; announcing none of them.`);
        return null;
      }
      return found[0] ?? null;
    }
    return null;
  }

  private async submitPasscode(page: Page): Promise<void> {
    if (this.options.headless === false || this.passcodeSubmitted) return;
    const input = page.getByRole("textbox", { name: /passcode|verification code/i }).first();
    if (!await input.isVisible().catch(() => false)) return;
    if (!this.options.requestMfaCode) {
      throw new UnsupportedAuthenticationError(`Duo requires a passcode. Run \`${AUTH_COMMAND}\` in a terminal to enter it.`);
    }

    this.passcodeSubmitted = true;
    const code = await this.options.requestMfaCode();
    if (!/^\d{6,8}$/.test(code)) throw new UnsupportedAuthenticationError("The MFA code must contain 6-8 digits.");
    // That prompt blocks on a person for as long as they take to find the
    // code, and Duo expires its prompt and redirects on its own schedule. A
    // passcode is a credential: confirm it is still Duo's page receiving it
    // rather than whatever the browser moved on to.
    if (!this.isChallenge(page)) {
      throw new UnsupportedAuthenticationError(`The Duo prompt closed before the passcode was entered. Run \`${AUTH_COMMAND}\` to retry.`);
    }
    await input.fill(code);
    const verify = page.getByRole("button", { name: /verify/i }).first();
    if (await verify.isVisible().catch(() => false)) await verify.click();
    else await input.press("Enter");
    log("INFO", "Duo passcode submitted");
  }
}
