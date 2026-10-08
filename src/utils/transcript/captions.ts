/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * Parsing for the two caption formats every platform adapter in
 * src/utils/transcript/ ends up serving: WebVTT and SRT. Both are just
 * "timestamp range, then text, blank line, repeat" — this module is the one
 * place that knows the timestamp punctuation differs (`.` vs `,`) and that
 * VTT can carry inline tags and cue settings SRT never does.
 */

export interface TranscriptCue {
  startMs: number;
  endMs: number;
  text: string;
}

export type CaptionFormat = "vtt" | "srt" | "timedtext";

/** "01:02:03.456" or "01:02:03,456" or the hours-omitted "02:03.456". */
function parseTimestamp(raw: string): number {
  const match = raw.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!match) return NaN;
  const [, hours, minutes, seconds, millis] = match;
  return (
    (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 +
    Number(millis)
  );
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", "#39": "'", "#34": '"',
};

/**
 * Decode the XML/HTML entities caption payloads carry. YouTube's tracks are
 * full of `&#39;` and `&amp;`, which used to reach the user verbatim.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/*
 * Only strip the tags captions actually use. The old `/<[^>]+>/g` ate
 * everything between any two angle brackets, so a lecture line like
 * "if x < y and y > z" silently lost the middle -- and maths and inequalities
 * are exactly what a course recording says out loud.
 */
const CAPTION_TAG = /<\/?(?:[0-9:.]+|c(?:\.[^>\s]*)?|v(?:\s[^>]*)?|b|i|u|ruby|rt|lang(?:\s[^>]*)?)>/gi;

function stripCaptionTags(text: string): string {
  return text.replace(CAPTION_TAG, "");
}

/**
 * YouTube's auto-generated tracks roll: each cue repeats the tail of the one
 * before it, so a naive join says every line two or three times. Drop a cue
 * whose text the previous cue already ended with.
 */
function dropRollingRepeats(cues: TranscriptCue[]): TranscriptCue[] {
  const out: TranscriptCue[] = [];
  for (const cue of cues) {
    const previous = out[out.length - 1];
    if (previous && (previous.text === cue.text || previous.text.endsWith(cue.text))) continue;
    if (previous && cue.text.startsWith(previous.text) && cue.text.length > previous.text.length) {
      out[out.length - 1] = { ...previous, endMs: cue.endMs, text: cue.text };
      continue;
    }
    out.push(cue);
  }
  return out;
}

/**
 * A TTML/DFXP time expression: a clock value ("00:00:01.500", optionally with
 * frames) or an offset ("1.5s", "150ms", "90f" treated as seconds-less).
 */
function parseTimeExpression(raw: string): number {
  const value = raw.trim();
  const offset = /^(\d+(?:\.\d+)?)(h|min|m|s|ms)?$/.exec(value);
  if (offset) {
    const n = Number(offset[1]);
    const unit = offset[2] ?? "s";
    const scale = unit === "h" ? 3600_000 : unit === "min" || unit === "m" ? 60_000 : unit === "ms" ? 1 : 1000;
    return Math.round(n * scale);
  }
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value);
  if (!clock) return NaN;
  const [, h, m, sec, frac] = clock;
  const millis = frac ? Number(frac.padEnd(3, "0")) : 0;
  return (Number(h ?? 0) * 3600 + Number(m) * 60 + Number(sec)) * 1000 + millis;
}

/**
 * Timed-text XML. Three shapes reach us: YouTube srv3 (`<p t= d=>`), YouTube
 * srv1 (`<text start= dur=>`), and TTML/DFXP (`<p begin= end=>`), which is
 * what Kaltura serves for many caption assets. TTML used to parse as zero
 * cues and be reported as a track with nothing readable in it.
 */
function parseTimedText(xml: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  const element = /<(p|text)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (const match of xml.matchAll(element)) {
    const attrs = match[2];
    const numericStart = /\b(?:t|start)="([\d.]+)"/.exec(attrs)?.[1];
    const numericDur = /\b(?:d|dur)="([\d.]+)"/.exec(attrs)?.[1];
    const beginRaw = /\bbegin="([^"]+)"/.exec(attrs)?.[1];
    const endRaw = /\bend="([^"]+)"/.exec(attrs)?.[1];
    const ttmlDur = /\bdur="([^"]+)"/.exec(attrs)?.[1];

    let startMs: number;
    let durMs: number;
    if (beginRaw !== undefined) {
      startMs = parseTimeExpression(beginRaw);
      const endMs = endRaw !== undefined ? parseTimeExpression(endRaw) : NaN;
      durMs = Number.isFinite(endMs)
        ? endMs - startMs
        : ttmlDur !== undefined ? parseTimeExpression(ttmlDur) : 0;
    } else if (numericStart !== undefined) {
      // srv3 counts milliseconds, srv1 counts fractional seconds.
      const seconds = match[1] === "text";
      startMs = Math.round(Number(numericStart) * (seconds ? 1000 : 1));
      durMs = numericDur === undefined ? 0 : Math.round(Number(numericDur) * (seconds ? 1000 : 1));
    } else {
      continue;
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(durMs)) continue;
    // <s> word segments inside a <p> carry the words for ASR tracks.
    const text = decodeEntities(match[3].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) cues.push({ startMs, endMs: startMs + Math.max(0, durMs), text });
  }
  return cues;
}

/**
 * Parse WebVTT or SRT text into cues. Format is detected from the WEBVTT
 * header rather than taken on faith, since a caller only knows what the
 * platform's API claims to have served.
 */
export function parseCaptions(raw: string): { format: CaptionFormat; cues: TranscriptCue[] } {
  const normalized = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const head = normalized.trimStart();
  // Dispatch on what actually arrived. Calling every non-VTT payload "srt" and
  // then finding no cues is how an XML or HTML body got reported as a caption
  // track with nothing readable in it.
  if (head.startsWith("<")) return { format: "timedtext", cues: dropRollingRepeats(parseTimedText(normalized)) };
  const format: CaptionFormat = /^WEBVTT\b/.test(head) ? "vtt" : "srt";

  const cues: TranscriptCue[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;

    const [startRaw, endRaw] = lines[timingIndex].split("-->");
    const startMs = parseTimestamp(startRaw.trim().split(/\s+/)[0] ?? "");
    const endMs = parseTimestamp((endRaw ?? "").trim().split(/\s+/)[0] ?? "");
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;

    const text = decodeEntities(stripCaptionTags(lines.slice(timingIndex + 1).join(" ")))
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push({ startMs, endMs, text });
  }

  return { format, cues: dropRollingRepeats(cues) };
}

/** "H:MM:SS", matching how course-length recordings are usually captioned. */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** One line per cue, timestamped, in reading order. */
export function cuesToText(cues: TranscriptCue[]): string {
  return cues.map((cue) => `[${formatTimestamp(cue.startMs)}] ${cue.text}`).join("\n");
}

export interface TextWindow {
  window: string;
  truncated: boolean;
  nextOffset: number | null;
  totalChars: number;
}

/** Character-offset paging, mirroring the maxChars/truncated convention used elsewhere for large text. */
export function paginateText(text: string, offset: number, maxChars: number): TextWindow {
  const totalChars = text.length;
  const window = text.slice(offset, offset + maxChars);
  const truncated = offset + maxChars < totalChars;
  return { window, truncated, nextOffset: truncated ? offset + maxChars : null, totalChars };
}
