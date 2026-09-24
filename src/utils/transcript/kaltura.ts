/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * Kaltura transcript retrieval — the priority-one platform from issue #33,
 * since Purdue's BoilerCast and many other D2L schools run on it.
 *
 * This does not reuse the Brightspace session: Kaltura is a separate SaaS
 * tenant with its own auth, and an embedded player normally authenticates
 * to it with a "widget session" (a KS token scoped read-only to the entries
 * a partner has made embeddable), not the D2L cookie. That widget-session
 * flow is the same mechanism generic Kaltura embed players use, and it is
 * anonymous by design — it needs no Brightspace credential to obtain. A
 * captions request that fails because the entry actually requires an
 * authenticated (non-widget) session surfaces as TranscriptFetchError, which
 * the tool turns into a "open it in Brightspace directly" message rather
 * than a silent empty result.
 */

import { parseCaptions } from "./captions.js";
import { NoTranscriptError, TranscriptFetchError } from "./errors.js";
import type { FetchLike, TranscriptResult } from "./types.js";

const KALTURA_API_BASE = "https://cdnapisec.kaltura.com/api_v3/service";

interface KalturaApiError {
  error?: { message?: string; code?: string };
}

interface KalturaCaptionAsset {
  id: string;
  languageCode?: string;
  language?: string;
  isDefault?: boolean;
}

async function startWidgetSession(partnerId: string, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(
    `${KALTURA_API_BASE}/session/action/startWidgetSession?widgetId=_${encodeURIComponent(partnerId)}&format=1`
  );
  if (!res.ok) {
    throw new TranscriptFetchError(`Kaltura session request failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as KalturaApiError & { ks?: string };
  if (data.error) {
    throw new TranscriptFetchError(
      `Kaltura rejected the session request: ${data.error.message ?? "unknown error"}.`
    );
  }
  if (!data.ks) {
    throw new TranscriptFetchError("Kaltura did not return a session token.");
  }
  return data.ks;
}

async function listCaptionAssets(
  ks: string,
  entryId: string,
  fetchImpl: FetchLike
): Promise<KalturaCaptionAsset[]> {
  const res = await fetchImpl(
    `${KALTURA_API_BASE}/caption_captionasset/action/list?format=1` +
      `&ks=${encodeURIComponent(ks)}&filter:entryIdEqual=${encodeURIComponent(entryId)}`
  );
  if (!res.ok) {
    throw new TranscriptFetchError(`Kaltura caption list request failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as KalturaApiError & { objects?: KalturaCaptionAsset[] };
  if (data.error) {
    throw new TranscriptFetchError(
      `Kaltura rejected the caption list request: ${data.error.message ?? "unknown error"}.`
    );
  }
  return data.objects ?? [];
}

async function serveCaption(ks: string, captionAssetId: string, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(
    `${KALTURA_API_BASE}/caption_captionasset/action/serve?ks=${encodeURIComponent(ks)}` +
      `&captionAssetId=${encodeURIComponent(captionAssetId)}`
  );
  if (!res.ok) {
    throw new TranscriptFetchError(`Kaltura caption download failed (HTTP ${res.status}).`);
  }
  return res.text();
}

/** Best-effort title/duration — a caption-only entry still has a usable transcript without this. */
async function fetchMediaInfo(
  ks: string,
  entryId: string,
  fetchImpl: FetchLike
): Promise<{ title: string | null; durationSeconds: number | null }> {
  try {
    const res = await fetchImpl(
      `${KALTURA_API_BASE}/media/action/get?ks=${encodeURIComponent(ks)}&entryId=${encodeURIComponent(entryId)}`
    );
    if (!res.ok) return { title: null, durationSeconds: null };
    const data = (await res.json()) as KalturaApiError & { name?: string; duration?: number };
    if (data.error) return { title: null, durationSeconds: null };
    return { title: data.name ?? null, durationSeconds: typeof data.duration === "number" ? data.duration : null };
  } catch {
    return { title: null, durationSeconds: null };
  }
}

export async function getKalturaTranscript(
  partnerId: string,
  entryId: string,
  fetchImpl: FetchLike
): Promise<TranscriptResult> {
  const ks = await startWidgetSession(partnerId, fetchImpl);
  const assets = await listCaptionAssets(ks, entryId, fetchImpl);

  if (assets.length === 0) {
    throw new NoTranscriptError("This Kaltura video has no captions available.");
  }

  const asset = assets.find((a) => a.isDefault) ?? assets[0];
  const raw = await serveCaption(ks, asset.id, fetchImpl);
  const { format, cues } = parseCaptions(raw);

  if (cues.length === 0) {
    throw new NoTranscriptError("This Kaltura video has a caption track, but it contained no readable cues.");
  }

  const media = await fetchMediaInfo(ks, entryId, fetchImpl);

  return {
    cues,
    format,
    language: asset.languageCode ?? asset.language ?? null,
    title: media.title,
    durationSeconds: media.durationSeconds,
  };
}
