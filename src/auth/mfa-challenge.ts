/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * The MFA challenge a sign-in is showing, shared with every process that
 * shares its session store (issue #199).
 *
 * Several server processes, one per open MCP client, can share one session
 * directory, and only the one holding the sign-in lock can sign in. The number
 * to enter used to reach the user only through the one tool call that started
 * that sign-in. The owner now writes its challenge into the lock directory, so
 * it disappears with the lock, and a contender reads it back and relays it.
 * Relaying touches the file, which tells the owner's server that someone is
 * still waiting on the sign-in (see AuthRunner's abandonment check).
 */

import * as fs from "node:fs/promises";
import { statSync } from "node:fs";
import * as path from "node:path";
import { CHALLENGE_FILE } from "./auth-lock.js";

export interface PendingChallenge {
  /** Entra number-match digits, when the challenge shows them. */
  numberMatch?: string;
}

/** Same bound the auth child's stdout marker enforces: 1-3 digits and nothing else. */
const NUMBER_MATCH = /^\d{1,3}$/;

export function authLockPath(sessionDir: string): string {
  return path.join(sessionDir, ".auth.lock");
}

/** Record the challenge this process's sign-in is showing. Call only while holding the lock. */
export async function publishChallenge(lockPath: string, numberMatch: string | null): Promise<void> {
  const challenge: PendingChallenge = numberMatch && NUMBER_MATCH.test(numberMatch) ? { numberMatch } : {};
  await fs.writeFile(path.join(lockPath, CHALLENGE_FILE), JSON.stringify(challenge), { mode: 0o600 });
}

/**
 * The challenge the lock owner is showing, or undefined when it has published
 * none. Marks the challenge as just relayed, so the owner keeps waiting.
 */
export async function relayChallenge(lockPath: string): Promise<PendingChallenge | undefined> {
  const file = path.join(lockPath, CHALLENGE_FILE);
  let challenge: unknown;
  try {
    challenge = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof challenge !== "object" || challenge === null) return undefined;
  const now = new Date();
  await fs.utimes(file, now, now).catch(() => {});
  const numberMatch = (challenge as { numberMatch?: unknown }).numberMatch;
  return typeof numberMatch === "string" && NUMBER_MATCH.test(numberMatch) ? { numberMatch } : {};
}

/** When the lock's challenge was last published or relayed, or undefined when there is none. */
export function challengeRelayedAt(lockPath: string): number | undefined {
  try {
    return statSync(path.join(lockPath, CHALLENGE_FILE)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The stdout marker AuthRunner parses for a challenge. */
export function challengeMarker(numberMatch: string | null | undefined): string {
  return numberMatch ? `MFA_NUMBER:${numberMatch}` : "MFA_PENDING";
}
