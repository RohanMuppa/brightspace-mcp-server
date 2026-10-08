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

/*
 * Two different error envelopes. `format=1` (JSON) returns a *top-level*
 * `KalturaAPIException` object -- not a nested `error` -- so checking only
 * `data.error` never fired: a rejected session or an access-controlled entry
 * left `objects` undefined, which read as an empty list and was reported as
 * "this video has no captions". Both shapes are now recognised.
 */
interface KalturaApiError {
  error?: { message?: string; code?: string };
  objectType?: string;
  code?: string;
  message?: string;
}

/** The API's own refusal, in either envelope, or undefined when it did not refuse. */
function apiException(data: KalturaApiError): string | undefined {
  if (data.error) return data.error.message ?? data.error.code ?? "unknown error";
  if (data.objectType === "KalturaAPIException") return data.message ?? data.code ?? "unknown error";
  return undefined;
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
  const refusal = apiException(data);
  if (refusal) {
    throw new TranscriptFetchError(`Kaltura rejected the caption list request: ${refusal}.`);
  }
  // A missing `objects` is a malformed answer, not an empty list. Only a real
  // empty array means the entry genuinely has no caption assets.
  if (!Array.isArray(data.objects)) {
    throw new TranscriptFetchError("Kaltura returned an unreadable caption list for this video.");
  }
  return data.objects;
}

async function serveCaption(ks: string, captionAssetId: string, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(
    `${KALTURA_API_BASE}/caption_captionasset/action/serve?ks=${encodeURIComponent(ks)}` +
      `&captionAssetId=${encodeURIComponent(captionAssetId)}`
  );
  if (!res.ok) {
    throw new TranscriptFetchError(`Kaltura caption download failed (HTTP ${res.status}).`);
  }
  const body = await res.text();
  // The asset was listed a moment ago, so nothing coming back is a refusal,
  // not an absence. An error page arrives as JSON here rather than as cues.
  if (!body.trim()) {
    throw new TranscriptFetchError("Kaltura listed a caption asset for this video but served an empty response for it.");
  }
  const refusal = body.trimStart().startsWith("{") ? apiException(JSON.parse(body) as KalturaApiError) : undefined;
  if (refusal) {
    throw new TranscriptFetchError(`Kaltura refused to serve the caption asset: ${refusal}.`);
  }
  return body;
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

  // Try the default asset first, then the rest: an entry can carry a stale or
  // empty asset alongside a good one, and giving up on the first was enough to
  // report a captioned lecture as having no transcript.
  const ordered = [...assets].sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
  let asset = ordered[0];
  let parsed: ReturnType<typeof parseCaptions> | undefined;
  let lastError: Error | undefined;
  for (const candidate of ordered) {
    try {
      const attempt = parseCaptions(await serveCaption(ks, candidate.id, fetchImpl));
      if (attempt.cues.length > 0) {
        asset = candidate;
        parsed = attempt;
        break;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : undefined;
    }
  }
  if (!parsed) {
    throw lastError ?? new TranscriptFetchError(
      "Kaltura served this video's caption assets in a format that could not be read.",
    );
  }
  const { format, cues } = parsed;

  const media = await fetchMediaInfo(ks, entryId, fetchImpl);

  return {
    cues,
    format,
    language: asset.languageCode ?? asset.language ?? null,
    title: media.title,
    durationSeconds: media.durationSeconds,
  };
}
