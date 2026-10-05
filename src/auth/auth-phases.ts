/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * The browser sign-in stages whose durations the automatic child reports to
 * the server (issue #182). A fixed list, so a stage name is never arbitrary
 * child output by the time it reaches the dev activity log.
 */
export const AUTH_PHASES = ["launch", "navigation", "silentSso", "credentials", "approvalWait", "token"] as const;
export type AuthPhase = typeof AUTH_PHASES[number];

const PHASE_MARKER = new RegExp(`^AUTH_PHASE:(${AUTH_PHASES.join("|")}):(\\d{1,9})$`);

/** The stdout line the automatic child prints when a stage ends. */
export function formatPhaseMarker(phase: AuthPhase, elapsedMs: number): string {
  return `AUTH_PHASE:${phase}:${Math.max(0, Math.round(elapsedMs))}`;
}

/** The stage and duration from a whole stdout line, or null for anything else. */
export function parsePhaseMarker(line: string): { phase: AuthPhase; elapsedMs: number } | null {
  const match = PHASE_MARKER.exec(line);
  return match ? { phase: match[1] as AuthPhase, elapsedMs: Number(match[2]) } : null;
}
