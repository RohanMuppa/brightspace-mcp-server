/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

/**
 * The form of a username that names its account. An email address (a
 * Microsoft Entra or Google sign-in) is case-insensitive, so it is lowercased;
 * a plain username keeps its case, because a school may treat it as
 * case-sensitive. Surrounding whitespace is never part of anyone's name.
 */
export function canonicalUsername(username: string): string {
  const trimmed = username.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed;
}
