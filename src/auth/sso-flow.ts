/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";
import type { AppConfig } from "../types/index.js";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { SunySSOFlow, isSunyBrightspace } from "./suny-sso.js";

/** The browser login sequence for one institution's identity provider. */
export interface SSOFlow {
  /** True when saved credentials allow an automated sign-in attempt. */
  hasCredentials(): boolean;
  /** Drive the sign-in form. Resolves false on timeout so the caller can fall back. */
  login(page: Page): Promise<boolean>;
  /** Wait for the user to sign in themselves in a visible browser. */
  manualLogin(page: Page): Promise<boolean>;
}

/**
 * Pick the login sequence for the configured Brightspace host. Schools whose
 * identity provider needs extra steps get their own handler here; everything
 * else uses the default flow, which already covers the common Shibboleth,
 * CAS, and Microsoft Entra forms.
 */
export function createSSOFlow(config: AppConfig): SSOFlow {
  const credentials = { username: config.username, password: config.password };

  if (isSunyBrightspace(config.baseUrl)) {
    return new SunySSOFlow({ ...credentials, campus: config.campus });
  }

  return new PurdueSSOFlow(credentials);
}
