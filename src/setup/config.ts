/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * The settings setup saves, shared by the wizard, prepare and sign-in.
 */

import { canonicalUsername } from "../auth/username.js";
import { configStoreExists, loadConfigStore, type ConfigStoreData } from "../utils/config-store.js";

// ── URL validation ─────────────────────────────────────────────────

export function normalizeUrl(input: string): string {
  let url = input.trim();
  // Strip trailing slashes
  url = url.replace(/\/+$/, "");
  // Auto-prepend https://
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  // Upgrade http:// to https://
  url = url.replace(/^http:\/\//i, "https://");
  return url;
}

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

// ── Saved settings ─────────────────────────────────────────────────

export interface WizardAnswers {
  baseUrl: string;
  username: string;
  password?: string;
  /** An authenticator enrollment to save; absent leaves any saved one alone. */
  totpUri?: string;
  headless: boolean;
  /** Left undefined, the saved choice for the same school is kept. */
  rememberMfa?: boolean;
  campus?: string;
}

/** The settings already on disk, or null when there are none to read. */
export function readExistingConfig(): ConfigStoreData | null {
  try {
    return configStoreExists() ? loadConfigStore() : null;
  } catch {
    // An unreadable config is replaced by the setup values.
    return null;
  }
}

export function sameSchool(stored: string | undefined, chosen: string): boolean {
  // A config that never recorded a school (environment-driven installs) is
  // not a *different* school, so its settings are still ours to keep.
  if (!stored) return true;
  try {
    return new URL(stored).origin === new URL(chosen).origin;
  } catch {
    return false;
  }
}

/**
 * The username to save: the typed one in canonical form, unless it names the
 * account already saved. That one keeps its saved spelling, because releases
 * up to 4.0.0 keyed its password, enrollment and session directory on the
 * exact case, and only that spelling still derives those legacy keys.
 */
export function savedUsername(saved: string | undefined, typed: string): string {
  const canonical = canonicalUsername(typed);
  return saved !== undefined && canonicalUsername(saved) === canonical ? saved : canonical;
}

/**
 * Merge the wizard's answers over the settings already saved.
 *
 * `saveConfigStore` replaces the whole file, and setup is the documented way
 * to update a saved password — so it runs again on configurations that carry
 * settings it never prompts for: the SUNY campus, course filters, a custom
 * session directory or token TTL. Writing only the answers deleted all of
 * them; most visibly, a SUNY user who reran plain `setup` lost the campus
 * that lets sign-in skip the shared campus picker.
 *
 * Settings are carried only within one school, since course ids and the
 * campus belong to a single tenant.
 */
export function buildConfigToSave(
  existing: ConfigStoreData | null,
  answers: WizardAnswers,
): ConfigStoreData {
  const carried = existing && sameSchool(existing.baseUrl, answers.baseUrl) ? existing : null;
  const config: ConfigStoreData = {
    ...carried,
    baseUrl: answers.baseUrl,
    username: savedUsername(carried?.username, answers.username),
    // Always the freshly typed one: a carried v1 plaintext password would
    // otherwise be the value written to the native store.
    password: answers.password,
    // Only ever the freshly typed one. Never read back out of `carried`: the
    // enrollment lives in the credential store, never in config.json, so a
    // value here could only have come from this run.
    ...(answers.totpUri ? { totpUri: answers.totpUri } : {}),
    headless: answers.headless,
  };
  if (answers.rememberMfa !== undefined) config.rememberMfa = answers.rememberMfa;
  // Setup no longer offers passwordless sign-in and always saves a password,
  // so a carried `passwordless: true` would make sign-in ignore that password.
  // D2L_PASSWORDLESS still turns it on for anyone who wants it.
  delete config.passwordless;
  if (answers.campus) config.campus = answers.campus;
  return config;
}
