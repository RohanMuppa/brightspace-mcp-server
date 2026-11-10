/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * System notifications (#424). macOS only, through /usr/bin/osascript, which
 * needs nothing installed. Never throws and never blocks the caller for more
 * than the timeout: a notification is a courtesy, not part of any result.
 */

import { execFile } from "node:child_process";
import path from "node:path";

export interface NotifyOptions {
  title: string;
  message: string;
  /**
   * A folder the notification is about. osascript notifications cannot carry
   * a click action, so this only adds the folder's name to the text.
   */
  openPath?: string;
}

/** Runs `file args` without a shell and resolves when it exits 0; rejects otherwise. */
export type NotifyRunner = (file: string, args: string[], timeoutMs: number) => Promise<void>;

export interface NotifyDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: NotifyRunner;
  timeoutMs?: number;
}

export const OSASCRIPT = "/usr/bin/osascript";
export const NOTIFY_TIMEOUT_MS = 5000;
const MAX_TITLE = 80;
const MAX_MESSAGE = 200;

/** Fixed AppleScript source: the text arrives as argv, never inside the script. */
export const NOTIFY_SCRIPT = [
  "on run argv",
  "display notification (item 1 of argv) with title (item 2 of argv)",
  "end run",
];

const defaultRun: NotifyRunner = (file, args, timeoutMs) =>
  new Promise<void>((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, killSignal: "SIGKILL" }, (error) => (error ? reject(error) : resolve()));
  });

/** One line with no control, escape or line-separator characters, capped at `max` characters. */
export function cleanNotificationText(text: unknown, max: number): string {
  const flat = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}\u2026` : flat;
}

/** The osascript arguments for a notification. The `--` keeps text starting with "-" from being read as an option. */
export function osascriptArgs(title: string, message: string): string[] {
  return [...NOTIFY_SCRIPT.flatMap((line) => ["-e", line]), "--", message, title];
}

/** False when the user turned notifications off with D2L_NOTIFY=0 (or false, no, off). */
export function notificationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.D2L_NOTIFY ?? "").trim());
}

/** Show a notification. Resolves true when one was shown, false otherwise; never rejects. */
export async function notify(options: NotifyOptions, deps: NotifyDeps = {}): Promise<boolean> {
  try {
    const platform = deps.platform ?? process.platform;
    if (platform !== "darwin" || !notificationsEnabled(deps.env ?? process.env)) return false;
    const title = cleanNotificationText(options?.title, MAX_TITLE) || "Brightspace";
    let message = cleanNotificationText(options?.message, MAX_MESSAGE);
    if (options?.openPath) {
      const folder = cleanNotificationText(path.basename(String(options.openPath)), 60);
      if (folder) message = cleanNotificationText(`${message} (${folder})`, MAX_MESSAGE);
    }
    if (!message) return false;
    await (deps.run ?? defaultRun)(OSASCRIPT, osascriptArgs(title, message), deps.timeoutMs ?? NOTIFY_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/** The same number is not shown again for this long: it is the same sign-in attempt. */
export const APPROVAL_REPEAT_MS = 2 * 60 * 1000;

/** number -> when it was last shown successfully. */
const approvalsShown = new Map<string, number>();
/** Numbers whose first send has not finished yet. */
const approvalsInFlight = new Set<string>();
let approvalsSuppressed = false;

/**
 * Turn the approval-number notification off for this process, for a command
 * (sync --notify) that abandons an expired sign-in instead of waiting for it:
 * a number nobody will use would only mislead.
 */
export function setApprovalNotificationsSuppressed(suppressed: boolean): void {
  approvalsSuppressed = suppressed;
}

/**
 * Tell the user which number to approve in their authenticator. A repeat of
 * the same number within APPROVAL_REPEAT_MS is the same attempt and stays
 * quiet; a later one (numbers repeat) is shown again. A number is recorded
 * only once its notification was shown, so a failed send is retried. Only the
 * 1-3 digit number is ever used.
 */
export async function notifyApprovalNumber(numberMatch: string | undefined, deps: NotifyDeps & { now?: () => number } = {}): Promise<boolean> {
  if (approvalsSuppressed || typeof numberMatch !== "string" || !/^\d{1,3}$/.test(numberMatch)) return false;
  const now = (deps.now ?? Date.now)();
  const last = approvalsShown.get(numberMatch);
  if (approvalsInFlight.has(numberMatch) || (last !== undefined && now - last < APPROVAL_REPEAT_MS)) return false;
  approvalsInFlight.add(numberMatch);
  try {
    const shown = await notify({ title: "Brightspace sign-in", message: `Approve ${numberMatch} in Microsoft Authenticator` }, deps);
    if (shown) approvalsShown.set(numberMatch, now);
    return shown;
  } finally {
    approvalsInFlight.delete(numberMatch);
  }
}

/** Forget what was shown (a sign-in attempt ended). Also for tests. */
export function resetApprovalNotifications(): void {
  approvalsShown.clear();
  approvalsInFlight.clear();
}
