/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/** A numeric reference as its character, or left as written when it names no code point (issue #352). */
function codePoint(whole: string, code: number): string {
  return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
}

/** Decode the character references Brightspace's HTML editor writes into attribute values. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) => codePoint(whole, parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (whole, dec: string) => codePoint(whole, parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The attributes of every `<tag>` element in `html`, names lowercased and
 * values entity-decoded. A value ends only at its own closing quote, so an
 * apostrophe inside a double-quoted href stays part of it.
 */
export function tagAttributes(html: string, tag: string): Map<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "gi"))].map(
    element =>
      new Map(
        [...element[0].matchAll(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map(match => [
          match[1].toLowerCase(),
          decodeEntities(match[3]),
        ])
      )
  );
}
