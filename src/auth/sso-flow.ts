/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";
import type { AppConfig } from "../types/index.js";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { SunySSOFlow, isSunyBrightspace } from "./suny-sso.js";
import { WesternSSOFlow, isWesternBrightspace } from "./western-sso.js";
import { TUDelftSSOFlow, isTUDelftBrightspace } from "./tudelft-sso.js";
import { CunySSOFlow, isCunyBrightspace } from "./cuny-sso.js";
import { LeidenSSOFlow, isLeidenBrightspace } from "./leiden-sso.js";
import { McgillSSOFlow, isMcgillBrightspace } from "./mcgill-sso.js";
import { JaverianaSSOFlow, isJaverianaBrightspace } from "./javeriana-sso.js";
import { BrowserAuthError } from "../utils/errors.js";
import type { RememberMfaResult } from "./microsoft-session.js";
import { AUTH_COMMAND } from "../utils/commands.js";

export type RequestMfaCode = () => Promise<string>;
/**
 * See PurdueSSOConfig.onMfaChallenge in purdue-sso.ts for the firing
 * contract: fires on the first MFA challenge (a number or null), and again
 * every time a different number replaces the one last announced.
 */
export type OnMfaChallenge = (number: string | null) => void;

export class UnsupportedAuthenticationError extends BrowserAuthError {
  readonly code = "AUTH_UNSUPPORTED";
  constructor(message: string, cause?: Error) {
    super(message, "sso_login", cause);
    this.name = "UnsupportedAuthenticationError";
  }
}

/**
 * An automatic verification-code sign-in that never reached Brightspace.
 * Distinct from MfaApprovalError because nobody was ever asked to approve
 * anything: telling the user to check their phone would be a lie, and the
 * caller-facing guidance has to say "still working" instead.
 * Idea from ElliotDrel/brightspace-mcp-server (branch codex/purdue-totp).
 */
export class AutomaticCodeAuthenticationError extends UnsupportedAuthenticationError {}

export class MfaApprovalError extends BrowserAuthError {
  readonly code = "AUTH_MFA_FAILED";
  /**
   * The Entra number-match digits shown when the timeout hit, if any were
   * seen. Already validated to 1-3 digits at the point it was scraped
   * (see purdue-sso.ts readNumberMatch) — safe to surface verbatim.
   */
  readonly numberMatch?: string;
  constructor(cause?: Error, numberMatch?: string) {
    super(`MFA approval failed or timed out after 5 minutes. Run ${AUTH_COMMAND} to retry.`, "mfa_approval", cause);
    this.name = "MfaApprovalError";
    this.numberMatch = numberMatch;
  }
}

/** The browser login sequence for one institution's identity provider. */
export interface SSOFlow {
  /** Pass known school and campus selectors without entering credentials. */
  prepareLogin?(page: Page): Promise<void>;
  /** Answer a federation's account picker (e.g. SURFconext) before the identity provider. */
  selectIdentityProvider?(page: Page): Promise<void>;
  /** Submit only the public account name so a saved IdP session can resume. */
  identifyAccount?(page: Page): Promise<boolean>;
  /** True when saved credentials allow an automated sign-in attempt. */
  hasCredentials(): boolean;
  /** Drive the supported automatic sign-in form, surfacing MFA in terminal logs. */
  login(page: Page): Promise<boolean>;
  /** What Entra's "Don't ask again" checkbox did during this login, if its MFA page appeared. */
  rememberMfaResult?(): RememberMfaResult | undefined;
}

/**
 * Pick the login sequence for the configured Brightspace host. Schools whose
 * identity provider needs extra steps get their own handler here; everything
 * else uses the default flow, which already covers the common Shibboleth,
 * CAS, and Microsoft Entra forms.
 */
export function createSSOFlow(
  config: AppConfig,
  requestMfaCode?: RequestMfaCode,
  onMfaChallenge?: OnMfaChallenge,
  onAutomaticPending?: () => void,
): SSOFlow {
  const credentials = {
    username: config.username,
    password: config.password,
    // Handed to every flow, gated by none: the enrollment is saved per
    // account, and the only code that reads it answers Microsoft Entra's
    // verification-code form on login.microsoftonline.com. Gating on a
    // school's own URL instead would hard-code one tenant into a
    // school-agnostic server, and would still be the wrong test — what
    // matters is the identity provider and the challenge it is showing.
    totpUri: config.totpUri,
    baseUrl: config.baseUrl,
    headless: config.headless,
    rememberMfa: config.rememberMfa,
    passwordless: config.passwordless,
    requestMfaCode,
    onMfaChallenge,
    onAutomaticPending,
  };

  if (isTUDelftBrightspace(config.baseUrl)) {
    return new TUDelftSSOFlow(credentials);
  }

  if (isLeidenBrightspace(config.baseUrl)) {
    return new LeidenSSOFlow(credentials);
  }

  if (isSunyBrightspace(config.baseUrl)) {
    return new SunySSOFlow({ ...credentials, campus: config.campus });
  }

  if (isWesternBrightspace(config.baseUrl)) {
    return new WesternSSOFlow(credentials);
  }

  if (isCunyBrightspace(config.baseUrl)) {
    return new CunySSOFlow(credentials);
  }

  if (isMcgillBrightspace(config.baseUrl)) {
    return new McgillSSOFlow(credentials);
  }

  if (isJaverianaBrightspace(config.baseUrl)) {
    return new JaverianaSSOFlow(credentials);
  }

  return new PurdueSSOFlow(credentials);
}
