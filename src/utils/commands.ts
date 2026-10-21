/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * Canonical command strings shown to users.
 *
 * Every npx command here is pinned to @latest deliberately. Invoking npx with
 * a bare package name, no version tag, prefers a binary already on PATH, so on
 * a machine with an old global install it silently runs that stale copy
 * instead of fetching the current release. That is exactly how a healthy
 * v2.0.0 server ended up printing instructions that executed v1.2.6, whose
 * sign-in flow no longer worked. Pinning makes every printed command
 * self-updating.
 *
 * Import these instead of writing the command inline. A release test greps the
 * source for untagged forms and fails the build if one reappears.
 */

import { presetForBaseUrl } from "../setup/presets.js";

export const PACKAGE_NAME = "brightspace-mcp-server";

/** Re-authenticate. Always runs the current published release. */
export const AUTH_COMMAND = `npx -y ${PACKAGE_NAME}@latest auth`;

/** End the saved Brightspace session on this computer. Always runs the current published release. */
export const LOGOUT_COMMAND = `npx -y ${PACKAGE_NAME}@latest auth --logout`;

/** Re-run the setup wizard. Always runs the current published release. */
export const SETUP_COMMAND = `npx -y ${PACKAGE_NAME}@latest setup`;

/** Diagnose a broken setup. Always runs the current published release. */
export const DOCTOR_COMMAND = `npx -y ${PACKAGE_NAME}@latest doctor`;

/** Bring a global install up to date. The only fix for a stale `npm i -g` copy. */
export const GLOBAL_INSTALL_COMMAND = `npm install -g ${PACKAGE_NAME}@latest`;

/** Drop cached npx copies so the next `@latest` genuinely refetches. */
export const CLEAR_NPX_CACHE_COMMAND = "npx clear-npx-cache";

/**
 * The school's flag for a setup command, or `--url <origin>` for a school
 * with no preset. An unreadable URL gives no school at all, which `setup`
 * then fills from the saved configuration.
 */
function schoolArgument(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  const match = presetForBaseUrl(baseUrl);
  if (match) return ` --${match.flag}`;
  try {
    return ` --url ${new URL(baseUrl).origin}`;
  } catch {
    return "";
  }
}

/**
 * The person's last setup step: enter the password, approve sign-in. Always
 * runs the current published release.
 */
export function signInCommand(baseUrl?: string): string {
  return `${SETUP_COMMAND}${schoolArgument(baseUrl)} --sign-in`;
}

/** The no-prompt setup an agent runs before handing over. Always runs the current published release. */
export function prepareCommand(baseUrl?: string): string {
  return `${SETUP_COMMAND}${schoolArgument(baseUrl)} --prepare`;
}
