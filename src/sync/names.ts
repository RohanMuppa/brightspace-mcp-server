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
/**
 * Format and invisible characters (bidirectional controls, zero-width and
 * joiner characters, tags, variation selectors, invisible fillers): they make
 * one name look like another, and they can hide a leading dot.
 */
const INVISIBLE = /[\p{Cf}͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ\u{e0100}-\u{e01ef}]/gu;
/** Noncharacters, private-use and unassigned code points, which some filesystems (APFS) refuse outright. */
const UNSUPPORTED = /[\p{Cn}\p{Co}]/gu;
/** A surrogate with no partner is not text; it would fail or be mangled when written. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * What a case-insensitive, normalising filesystem treats as one name: NFC and
 * a full case fold (ß and SS, ς and σ, ſ and s, ﬁ and fi are the same name).
 */
export function foldKey(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase();
}

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

const charCount = (text: string): number => Array.from(text).length;

const trimEnds = (name: string): string => name.replace(/^\s+/, "").replace(/[.\s ]+$/, "");

/** Split `name.ext` at its last dot; a leading dot or an overlong tail is not an extension. */
export function splitExtension(name: string): { stem: string; ext: string } {
  const ext = path.extname(name);
  if (!ext || ext === name || charCount(ext) > MAX_EXTENSION_CHARS) return { stem: name, ext: "" };
  return { stem: name.slice(0, name.length - ext.length), ext };
}

/** `name` cut to `maxChars` characters (and the byte limit), keeping its extension when there is room for a stem. */
function fit(name: string, maxChars: number): string {
  if (charCount(name) <= maxChars && Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
  const { stem, ext } = splitExtension(name);
  const keepExt = charCount(ext) < maxChars && Buffer.byteLength(ext) < MAX_NAME_BYTES;
  if (!keepExt) return trimEnds(clip(name, maxChars, MAX_NAME_BYTES));
  const room = maxChars - charCount(ext);
  const roomBytes = MAX_NAME_BYTES - Buffer.byteLength(ext);
  return trimEnds(clip(stem, room, roomBytes)) + ext;
}

/**
 * Reduce a remote name to one safe path component: Windows-invalid characters
 * replaced, invisible and unsupported code points removed or replaced,
 * trailing dots and spaces removed, reserved device names prefixed, at most
 * `maxChars` (150) characters (the extension kept when it fits), NFC-normalised.
 * A leading dot is prefixed with "_", so a course can never create a
 * dot-folder or dot-file (".ssh", ".zshrc") in the destination. Never empty,
 * never "." or "..", never containing a separator: `fallback` stands in.
 */
export function sanitizeComponent(raw: string, fallback: string, maxChars: number = MAX_NAME_CHARS): string {
  let name = String(raw).replace(LONE_SURROGATE, "\ufffd").normalize("NFC").replace(INVISIBLE, "").replace(WINDOWS_INVALID, "_").replace(UNSUPPORTED, "_");
  // A combining mark with nothing to combine with could sit in front of a dot.
  name = trimEnds(name.replace(/^\p{M}+/u, ""));
  if (name === "") return fallback;
  if (name.startsWith(".")) name = `_${name}`;

  name = trimEnds(fit(name, maxChars).normalize("NFC"));
  // Windows reserves the part before the first dot ("NUL.tar.gz" is as bad as "NUL"), judged on the final name.
  if (WINDOWS_RESERVED.test(name.split(".")[0].trimEnd())) name = trimEnds(fit(`_${name}`, maxChars));
  return name === "" || name === "." || name === ".." ? fallback : name;
}

/** Base name of a Url's path: no query, no fragment, no directories. */
function urlBasename(url: string): string {
  const pathOnly = url.split(/[?#]/)[0];
  return pathOnly.split(/[/\\]/).pop() ?? "";
}

/** A valid %XX escape left in a name would be decoded a second time by anything that decodes names, so none is left. */
const neutraliseEscapes = (name: string): string => name.replace(/%(?=[0-9a-fA-F]{2})/g, "_");

/**
 * The name a File topic is saved under: the original upload's name from the
 * topic Url, decoded only when it is percent-encoded, else the topic title
 * with the Url's extension. No percent escape survives in either.
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
  base = neutraliseEscapes(base);

  const { stem, ext } = splitExtension(base);
  const useBase = stem.trim() !== "" && !/^\.+$/.test(base);
  if (useBase) return sanitizeComponent(base, sanitizeComponent(neutraliseEscapes(title), fallback));
  return sanitizeComponent(neutraliseEscapes(`${title}${ext}`), fallback);
}

/**
 * The names already taken in one folder, compared the way the filesystem
 * compares them (see foldKey), so "Notes.pdf" and "notes.pdf" cannot
 * overwrite each other on macOS or Windows. A repeat becomes "name (2).ext",
 * "name (3).ext", ... Numbering resumes where the last repeat of the same
 * name stopped, so n repeats cost n steps, not n squared.
 */
export class NameSet {
  private readonly taken = new Set<string>();
  private readonly nextNumber = new Map<string, number>();

  constructor(private readonly maxChars: number = MAX_NAME_CHARS) {}

  add(name: string, isFolder = false): string {
    const key = foldKey(name);
    if (!this.taken.has(key)) {
      this.taken.add(key);
      return name;
    }
    const { stem, ext } = isFolder ? { stem: name, ext: "" } : splitExtension(name);
    for (let n = this.nextNumber.get(key) ?? 2; ; n++) {
      const suffix = ` (${n})`;
      // An extension too long to leave room for a stem is dropped rather than break the cap.
      const keepExt = charCount(ext) + charCount(suffix) < this.maxChars;
      const tail = `${suffix}${keepExt ? ext : ""}`;
      const room = Math.max(1, this.maxChars - charCount(tail));
      const roomBytes = Math.max(1, MAX_NAME_BYTES - Buffer.byteLength(tail));
      const candidate = `${trimEnds(clip(stem, room, roomBytes))}${tail}`;
      const candidateKey = foldKey(candidate);
      if (!this.taken.has(candidateKey)) {
        this.taken.add(candidateKey);
        this.nextNumber.set(key, n + 1);
        return candidate;
      }
    }
  }
}
