import type { Page } from "playwright";
import { log } from "../utils/logger.js";
import { AUTH_COMMAND } from "../utils/commands.js";
import { UnsupportedAuthenticationError } from "./sso-flow.js";
import type { RequestMfaCode } from "./sso-flow.js";

interface DuoMfaOptions {
  headless?: boolean;
  requestMfaCode?: RequestMfaCode;
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

  constructor(private readonly options: DuoMfaOptions) {}

  isChallenge(page: Page): boolean {
    return isDuoPrompt(page);
  }

  /** Returns true while the page is on a Duo challenge. */
  async handle(page: Page): Promise<boolean> {
    if (!this.isChallenge(page)) return false;

    if (!this.approvalAnnounced) {
      this.approvalAnnounced = true;
      log("WARN", "Waiting up to 5 minutes for Duo MFA approval on your device.");
    }

    const verificationCode = await this.readVerificationCode(page);
    if (verificationCode && verificationCode !== this.verificationCodeAnnounced) {
      this.verificationCodeAnnounced = verificationCode;
      log("WARN", `Duo verification code: ${verificationCode}. Enter it in Duo Mobile.`);
    }

    await this.submitPasscode(page);
    return true;
  }

  private async readVerificationCode(page: Page): Promise<string | null> {
    const target = page.getByText(/^\d{3,6}$/).first();
    if (!await target.isVisible().catch(() => false)) return null;
    const code = (await target.textContent().catch(() => null))?.trim();
    return code && /^\d{3,6}$/.test(code) ? code : null;
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
    await input.fill(code);
    const verify = page.getByRole("button", { name: /verify/i }).first();
    if (await verify.isVisible().catch(() => false)) await verify.click();
    else await input.press("Enter");
    log("INFO", "Duo passcode submitted");
  }
}
