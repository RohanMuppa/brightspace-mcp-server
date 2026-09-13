/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * Recognising a missing Playwright browser.
 *
 * This package's postinstall downloads Chromium. npm skips postinstall under
 * `--ignore-scripts` and under the newer allow-scripts policy, both of which
 * are common on global installs, so the package can land without a browser and
 * fail only later, at first sign-in.
 *
 * Playwright's own message does say what to run, but by the time it has been
 * wrapped in BrowserAuthError and then flattened into a generic
 * "Authentication failed" by the auth runner, the actionable command is gone.
 * Matching the error lets us keep the fix attached to the failure.
 *
 * Matching reactively rather than probing for the executable up front keeps us
 * off Playwright's internals, and means no false positives: this only ever
 * fires after a launch has genuinely failed.
 */

import { CLEAR_NPX_CACHE_COMMAND } from "./commands.js";

export const PLAYWRIGHT_INSTALL_HINT =
  "Chromium is not installed, so sign-in cannot start. Your package manager " +
  "skipped this package's postinstall script, which is what normally downloads it " +
  "(common with --ignore-scripts or an allow-scripts policy). Run: " +
  "npx playwright install chromium" +
  `. If that does not help, reinstall and clear caches with ${CLEAR_NPX_CACHE_COMMAND}.`;

/** True when an error is Playwright reporting that no browser binary exists. */
export function isMissingBrowserError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  return /Executable doesn't exist|playwright install|Failed to launch.*because executable doesn't exist/i.test(
    message
  );
}
