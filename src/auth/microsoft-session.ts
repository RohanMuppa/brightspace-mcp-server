/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { BROWSER_STATE_FILE, type BrowserState } from "./browser-state-store.js";

/**
 * What Microsoft Entra remembered for this account, kept as a small plain
 * summary next to the encrypted browser state. It carries cookie names'
 * expiry times and the remember-MFA outcome, never a cookie value, so
 * get_server_info can report it without decrypting the cookie jar.
 */

export type RememberMfaOutcome = "ticked" | "already" | "absent" | "unknown";

export interface RememberMfaResult {
  outcome: RememberMfaOutcome;
  /** ISO time the MFA page was handled. */
  at: string;
}

export interface MicrosoftSession {
  staySignedIn: boolean;
  staySignedInExpires: string | null;
  rememberMfa: RememberMfaOutcome;
  rememberMfaAt: string | null;
}

interface SummaryFile {
  version: 1;
  /** ESTSAUTHPERSISTENT's expiry in Unix seconds, -1 for a session cookie, null when absent. */
  persistentExpires: number | null;
  rememberMfa: RememberMfaResult | null;
}

const SUMMARY_FILE = "microsoft-session.json";
const ENTRA_HOST = "login.microsoftonline.com";
const ENTRA_COOKIES = new Set(["ESTSAUTH", "ESTSAUTHPERSISTENT", "ESTSAUTHLIGHT"]);
const OUTCOMES: readonly RememberMfaOutcome[] = ["ticked", "already", "absent", "unknown"];

/** Latest expiry of each Entra sign-in cookie in a jar. */
function entraExpiries(state: BrowserState | undefined): Map<string, number> {
  const expiries = new Map<string, number>();
  for (const cookie of state?.cookies ?? []) {
    if (!ENTRA_COOKIES.has(cookie.name) || cookie.domain.replace(/^\./, "") !== ENTRA_HOST) continue;
    expiries.set(cookie.name, Math.max(cookie.expires, expiries.get(cookie.name) ?? -Infinity));
  }
  return expiries;
}

/**
 * True when the current jar holds an Entra sign-in cookie the previous one
 * lacked, or one that now expires later. A jar with no Entra cookies is never
 * newer, so a failed run cannot replace saved state with an empty one.
 */
export function hasNewerEntraState(previous: BrowserState | undefined, current: BrowserState): boolean {
  const before = entraExpiries(previous);
  return [...entraExpiries(current)].some(([name, expires]) => {
    const old = before.get(name);
    return old === undefined || expires > old;
  });
}

function validSummary(value: unknown): value is SummaryFile {
  const summary = value as SummaryFile | null;
  return !!summary && summary.version === 1
    && (summary.persistentExpires === null || Number.isFinite(summary.persistentExpires))
    && (summary.rememberMfa === null || (OUTCOMES.includes(summary.rememberMfa?.outcome) && typeof summary.rememberMfa.at === "string"));
}

async function readSummary(sessionDir: string): Promise<SummaryFile | undefined> {
  try {
    const summary = JSON.parse(await fs.readFile(path.join(sessionDir, SUMMARY_FILE), "utf8"));
    return validSummary(summary) ? summary : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record what Microsoft remembered in a browser state that was just saved.
 * A login that never reached the MFA page keeps the last recorded outcome.
 */
export async function recordMicrosoftSession(sessionDir: string, state: BrowserState, rememberMfa?: RememberMfaResult): Promise<void> {
  const summary: SummaryFile = {
    version: 1,
    persistentExpires: entraExpiries(state).get("ESTSAUTHPERSISTENT") ?? null,
    rememberMfa: rememberMfa ?? (await readSummary(sessionDir))?.rememberMfa ?? null,
  };
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(path.join(sessionDir, SUMMARY_FILE), JSON.stringify(summary), { mode: 0o600 });
}

/** The summary for saved browser state, or undefined when there is none. */
export async function readMicrosoftSession(sessionDir: string, now = Date.now()): Promise<MicrosoftSession | undefined> {
  try {
    await fs.access(path.join(sessionDir, BROWSER_STATE_FILE));
  } catch {
    return undefined;
  }
  const summary = await readSummary(sessionDir);
  if (!summary) return undefined;
  const expires = summary.persistentExpires;
  const staySignedIn = expires !== null && (expires === -1 || expires * 1000 > now);
  return {
    staySignedIn,
    staySignedInExpires: staySignedIn && expires! > 0 ? new Date(expires! * 1000).toISOString() : null,
    rememberMfa: summary.rememberMfa?.outcome ?? "unknown",
    rememberMfaAt: summary.rememberMfa?.at ?? null,
  };
}
