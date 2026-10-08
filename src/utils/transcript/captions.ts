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
 * YouTube's timedtext XML, which its signed caption URLs serve when they
 * ignore `fmt`. Two shapes: srv3 `<p t= d=>` and srv1 `<text start= dur=>`.
 */
function parseTimedText(xml: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  const element = /<(p|text)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (const match of xml.matchAll(element)) {
    const attrs = match[2];
    const startRaw = /\b(?:t|start)="([\d.]+)"/.exec(attrs)?.[1];
    const durRaw = /\b(?:d|dur)="([\d.]+)"/.exec(attrs)?.[1];
    if (startRaw === undefined) continue;
    // srv3 counts milliseconds, srv1 counts fractional seconds.
    const seconds = match[1] === "text";
    const startMs = Math.round(Number(startRaw) * (seconds ? 1000 : 1));
    const durMs = durRaw === undefined ? 0 : Math.round(Number(durRaw) * (seconds ? 1000 : 1));
    if (!Number.isFinite(startMs)) continue;
    // <s> word segments inside a <p> carry the words for ASR tracks.
    const text = decodeEntities(match[3].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) cues.push({ startMs, endMs: startMs + durMs, text });
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
