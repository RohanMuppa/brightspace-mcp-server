/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";
import type { AppConfig } from "../types/index.js";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { SunySSOFlow, isSunyBrightspace } from "./suny-sso.js";
import { BrowserAuthError } from "../utils/errors.js";
import { AUTH_COMMAND } from "../utils/commands.js";

export type RequestMfaCode = () => Promise<string>;

export class UnsupportedAuthenticationError extends BrowserAuthError {
  readonly code = "AUTH_UNSUPPORTED";
  constructor(message: string, cause?: Error) {
    super(message, "sso_login", cause);
    this.name = "UnsupportedAuthenticationError";
  }
}

export class MfaApprovalError extends BrowserAuthError {
  readonly code = "AUTH_MFA_FAILED";
  constructor(cause?: Error) {
    super(`MFA approval failed or timed out after 5 minutes. Run ${AUTH_COMMAND} to retry.`, "mfa_approval", cause);
    this.name = "MfaApprovalError";
  }
}

/** The browser login sequence for one institution's identity provider. */
export interface SSOFlow {
  /** Pass known school and campus selectors without entering credentials. */
  prepareLogin?(page: Page): Promise<void>;
  /** Submit only the public account name so a saved IdP session can resume. */
  identifyAccount?(page: Page): Promise<boolean>;
  /** True when saved credentials allow an automated sign-in attempt. */
  hasCredentials(): boolean;
  /** Drive the supported automatic sign-in form, surfacing MFA in terminal logs. */
  login(page: Page): Promise<boolean>;
}

/**
 * Pick the login sequence for the configured Brightspace host. Schools whose
 * identity provider needs extra steps get their own handler here; everything
 * else uses the default flow, which already covers the common Shibboleth,
 * CAS, and Microsoft Entra forms.
 */
export function createSSOFlow(config: AppConfig, requestMfaCode?: RequestMfaCode): SSOFlow {
  const credentials = {
    username: config.username,
    password: config.password,
    baseUrl: config.baseUrl,
    headless: config.headless,
    requestMfaCode,
  };

  if (isSunyBrightspace(config.baseUrl)) {
    return new SunySSOFlow({ ...credentials, campus: config.campus });
  }

  return new PurdueSSOFlow(credentials);
}
