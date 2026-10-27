/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/** A numeric reference as its character, or left as written when it names no code point (issue #352). */
function codePoint(whole: string, code: number): string {
  return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
}

const NAMED: Record<string, string> = { quot: '"', lt: "<", gt: ">", amp: "&" };

/**
 * Decode the character references Brightspace's HTML editor writes into
 * attribute values, in one pass so a decoded `&` never starts another
 * reference: `&#38;lt;` is the text `&lt;`, not `<` (issue #360).
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(quot|lt|gt|amp));/g, (whole, hex?: string, dec?: string, name?: string) => {
    if (hex !== undefined) return codePoint(whole, parseInt(hex, 16));
    if (dec !== undefined) return codePoint(whole, parseInt(dec, 10));
    return NAMED[name!];
  });
}

/**
 * The attributes of every `<tag>` element in `html`, names lowercased and
 * values entity-decoded. A value ends only at its own closing quote, so an
 * apostrophe inside a double-quoted href stays part of it, and the element
 * ends at the first `>` outside a quoted value: `title="Week 1 > Notes"` keeps
 * the attributes after it (issue #376). A tag with an unbalanced or stray
 * quote ends at its first `>`, as it always has.
 */
export function tagAttributes(html: string, tag: string): Map<string, string>[] {
  // A quote opens a value only right after `=`; any other quote, or one never
  // closed, fails the first form and leaves the second.
  const pattern = `<${tag}\\b(?:=\\s*(?:"[^"]*"|'[^']*')|[^>"'])*>|<${tag}\\b[^>]*>`;
  return [...html.matchAll(new RegExp(pattern, "gi"))].map(
    element =>
      new Map(
        [...element[0].matchAll(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map(match => [
          match[1].toLowerCase(),
          decodeEntities(match[3]),
        ])
      )
  );
}
