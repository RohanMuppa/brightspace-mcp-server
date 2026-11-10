/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Names for a synced course on disk. Module titles and file names come from
 * Brightspace, so they are remote input: every one is reduced to a single
 * path component that is safe on Windows, macOS and Linux alike.
 */

import path from "node:path";

/** Longest name, in characters, that a synced file or folder gets. */
const MAX_NAME_CHARS = 150;
/** Filesystems cap a name at 255 bytes; this leaves room for " (99)" and the downloader's own checks. */
const MAX_NAME_BYTES = 240;
const MAX_EXTENSION_CHARS = 20;

const WINDOWS_INVALID = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g;
/** Bidirectional controls and zero-width characters: they make one name look like another. */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

const clip = (text: string, maxChars: number, maxBytes: number): string => {
  let out = "";
  let bytes = 0;
  let chars = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    chars++;
    if (chars > maxChars || bytes > maxBytes) break;
    out += char;
  }
  return out;
};

const trimEnds = (name: string): string => name.replace(/^\s+/, "").replace(/[.  ]+$/, "");

/** Split `name.ext` at its last dot; a leading dot or an overlong tail is not an extension. */
export function splitExtension(name: string): { stem: string; ext: string } {
  const ext = path.extname(name);
  if (!ext || ext === name || Array.from(ext).length > MAX_EXTENSION_CHARS) return { stem: name, ext: "" };
  return { stem: name.slice(0, name.length - ext.length), ext };
}

/**
 * Reduce a remote name to one safe path component: Windows-invalid characters
 * replaced, trailing dots and spaces removed, reserved device names prefixed,
 * at most 150 characters (the extension kept), NFC-normalised. Never empty,
 * never "." or "..", never containing a separator: `fallback` stands in.
 */
export function sanitizeComponent(raw: string, fallback: string): string {
  let name = String(raw).normalize("NFC").replace(INVISIBLE, "").replace(WINDOWS_INVALID, "_");
  name = trimEnds(name);
  if (name === "") return fallback;

  // Windows reserves the part before the first dot, so "NUL.tar.gz" is as bad as "NUL".
  if (WINDOWS_RESERVED.test(name.split(".")[0].trimEnd())) name = `_${name}`;

  if (Array.from(name).length > MAX_NAME_CHARS || Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const { stem, ext } = splitExtension(name);
    const room = Math.max(1, MAX_NAME_CHARS - Array.from(ext).length);
    const roomBytes = Math.max(1, MAX_NAME_BYTES - Buffer.byteLength(ext));
    name = trimEnds(clip(stem, room, roomBytes)) + ext;
  }
  name = trimEnds(name.normalize("NFC"));
  return name === "" || name === "." || name === ".." ? fallback : name;
}

/** Base name of a Url's path: no query, no fragment, no directories. */
function urlBasename(url: string): string {
  const pathOnly = url.split(/[?#]/)[0];
  return pathOnly.split(/[/\\]/).pop() ?? "";
}

/**
 * The name a File topic is saved under: the original upload's name from the
 * topic Url, decoded only when it is percent-encoded, else the topic title
 * with the Url's extension.
 */
export function fileNameFromTopic(url: string | null | undefined, title: string, fallback: string): string {
  let base = urlBasename(url ?? "");
  if (/%[0-9a-fA-F]{2}/.test(base)) {
    try {
      base = decodeURIComponent(base);
    } catch {
      // A stray '%' next to a real escape: keep the name as Brightspace wrote it.
    }
  }
  // The downloader decodes a name once more, so a surviving valid escape ("%2541" decoded
  // to "%41") would be saved as something other than the name planned here.
  base = base.replace(/%(?=[0-9a-fA-F]{2})/g, "_");

  const { stem, ext } = splitExtension(base);
  const useBase = stem.trim() !== "" && !/^\.+$/.test(base);
  if (useBase) return sanitizeComponent(base, sanitizeComponent(title, fallback));
  return sanitizeComponent(`${title}${ext}`, fallback);
}

/**
 * The names already taken in one folder, compared case-insensitively so
 * "Notes.pdf" and "notes.pdf" cannot overwrite each other on macOS or
 * Windows. A repeat becomes "name (2).ext", "name (3).ext", ...
 */
export class NameSet {
  private readonly taken = new Set<string>();

  add(name: string, isFolder = false): string {
    const key = (n: string) => n.normalize("NFC").toLowerCase();
    if (!this.taken.has(key(name))) {
      this.taken.add(key(name));
      return name;
    }
    const { stem, ext } = isFolder ? { stem: name, ext: "" } : splitExtension(name);
    for (let n = 2; ; n++) {
      const suffix = ` (${n})${ext}`;
      const room = Math.max(1, MAX_NAME_CHARS - Array.from(suffix).length);
      const roomBytes = Math.max(1, MAX_NAME_BYTES - Buffer.byteLength(suffix));
      const candidate = `${trimEnds(clip(stem, room, roomBytes))}${suffix}`;
      if (!this.taken.has(key(candidate))) {
        this.taken.add(key(candidate));
        return candidate;
      }
    }
  }
}
