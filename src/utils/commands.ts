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

export const PACKAGE_NAME = "brightspace-mcp-server";

/** Re-authenticate. Always runs the current published release. */
export const AUTH_COMMAND = `npx -y ${PACKAGE_NAME}@latest auth`;

/** Re-run the setup wizard. Always runs the current published release. */
export const SETUP_COMMAND = `npx -y ${PACKAGE_NAME}@latest setup`;

/** Bring a global install up to date. The only fix for a stale `npm i -g` copy. */
export const GLOBAL_INSTALL_COMMAND = `npm install -g ${PACKAGE_NAME}@latest`;

/** Drop cached npx copies so the next `@latest` genuinely refetches. */
export const CLEAR_NPX_CACHE_COMMAND = "npx clear-npx-cache";
