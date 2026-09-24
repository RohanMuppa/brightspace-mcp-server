/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * YouTube transcript retrieval via its public timedtext endpoint. No
 * authentication is needed — this is the same caption track a signed-out
 * browser can fetch — so unlike Kaltura there is no session to reuse or fail
 * to obtain.
 */

import { parseCaptions } from "./captions.js";
import { NoTranscriptError, TranscriptFetchError } from "./errors.js";
import type { FetchLike, TranscriptResult } from "./types.js";

const TIMEDTEXT_BASE = "https://www.youtube.com/api/timedtext";

async function listCaptionTracks(videoId: string, fetchImpl: FetchLike): Promise<string[]> {
  const res = await fetchImpl(`${TIMEDTEXT_BASE}?type=list&v=${encodeURIComponent(videoId)}`);
  if (!res.ok) {
    throw new TranscriptFetchError(`YouTube caption list request failed (HTTP ${res.status}).`);
  }
  const xml = await res.text();
  return [...xml.matchAll(/<track\b[^>]*\blang_code="([^"]+)"/g)].map((m) => m[1]);
}

async function fetchTitle(videoId: string, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const res = await fetchImpl(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`);
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: string };
    return data.title ?? null;
  } catch {
    return null;
  }
}

export async function getYouTubeTranscript(videoId: string, fetchImpl: FetchLike): Promise<TranscriptResult> {
  const tracks = await listCaptionTracks(videoId, fetchImpl);
  if (tracks.length === 0) {
    throw new NoTranscriptError("This YouTube video has no caption tracks available.");
  }

  const lang = tracks.find((t) => t.startsWith("en")) ?? tracks[0];
  const res = await fetchImpl(
    `${TIMEDTEXT_BASE}?lang=${encodeURIComponent(lang)}&v=${encodeURIComponent(videoId)}&fmt=vtt`
  );
  if (!res.ok) {
    throw new TranscriptFetchError(`YouTube caption download failed (HTTP ${res.status}).`);
  }
  const vtt = await res.text();
  if (!vtt.trim()) {
    throw new NoTranscriptError("This YouTube video has no caption tracks available.");
  }

  const { format, cues } = parseCaptions(vtt);
  if (cues.length === 0) {
    throw new NoTranscriptError("This YouTube video has a caption track, but it contained no readable cues.");
  }

  const title = await fetchTitle(videoId, fetchImpl);

  return { cues, format, language: lang, title, durationSeconds: null };
}
