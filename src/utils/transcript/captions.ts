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

export type CaptionFormat = "vtt" | "srt";

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

/**
 * Parse WebVTT or SRT text into cues. Format is detected from the WEBVTT
 * header rather than taken on faith, since a caller only knows what the
 * platform's API claims to have served.
 */
export function parseCaptions(raw: string): { format: CaptionFormat; cues: TranscriptCue[] } {
  const normalized = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const format: CaptionFormat = /^WEBVTT/.test(normalized.trimStart()) ? "vtt" : "srt";

  const cues: TranscriptCue[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;

    const [startRaw, endRaw] = lines[timingIndex].split("-->");
    const startMs = parseTimestamp(startRaw.trim().split(/\s+/)[0] ?? "");
    const endMs = parseTimestamp((endRaw ?? "").trim().split(/\s+/)[0] ?? "");
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;

    const text = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (text) cues.push({ startMs, endMs, text });
  }

  return { format, cues };
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
