/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/**
 * YouTube transcript retrieval. Still no authentication: this is the caption
 * track a signed-out viewer can read.
 *
 * It no longer uses `api/timedtext?type=list`. That endpoint now answers
 * HTTP 200 with an empty body for every video, captioned or not, so listing
 * tracks through it reported "this video has no captions" universally.
 *
 * The track list comes from YouTube's InnerTube player endpoint instead,
 * asked as one of the mobile clients. The client identity matters: the signed
 * caption URLs a browser page hands out are stamped `exp=xpe` and require a
 * proof-of-origin token this server cannot mint, while the mobile clients'
 * URLs are stamped `exp=xpo` and serve captions as-is. Both were measured;
 * see the markers below.
 */

import { parseCaptions } from "./captions.js";
import { NoTranscriptError, TranscriptFetchError } from "./errors.js";
import type { FetchLike, TranscriptResult } from "./types.js";

const PLAYER_ENDPOINT = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

/**
 * Client versions rot: YouTube eventually refuses one outright, and the
 * symptom is a non-OK playabilityStatus for every video at once. Bump these.
 */
const CLIENTS = [
  {
    name: "ANDROID",
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
    context: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en", gl: "US" },
  },
  {
    name: "IOS",
    userAgent: "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    context: {
      clientName: "IOS", clientVersion: "21.26.4", deviceMake: "Apple", deviceModel: "iPhone16,2",
      osName: "iPhone", osVersion: "18.3.2.22D82", hl: "en", gl: "US",
    },
  },
] as const;

/** A caption track as the player response describes it. */
interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
  name?: { runs?: Array<{ text?: string }>; simpleText?: string };
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; lengthSeconds?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      audioTracks?: Array<{ defaultCaptionTrackIndex?: number; captionTrackIndices?: number[] }>;
      defaultAudioTrackIndex?: number;
    };
  };
}

function trackLabel(track: CaptionTrack): string | undefined {
  return track.name?.runs?.[0]?.text ?? track.name?.simpleText;
}

/**
 * What the player said about a video that will not play for us. These are
 * distinct from "has no captions", and saying so is the whole point: a
 * bot check or an age gate used to be reported as an absent transcript.
 */
function playabilityFailure(status: string, reason: string | undefined): Error {
  const detail = reason ? ` YouTube said: ${reason}` : "";
  if (status === "LOGIN_REQUIRED") {
    return new TranscriptFetchError(`YouTube would not serve this video without a sign-in.${detail}`);
  }
  if (status === "UNPLAYABLE" || status === "ERROR") {
    return new TranscriptFetchError(`YouTube reports this video as unavailable.${detail}`);
  }
  return new TranscriptFetchError(`YouTube refused to describe this video (${status}).${detail}`);
}

async function requestPlayer(videoId: string, fetchImpl: FetchLike): Promise<PlayerResponse> {
  let lastError: Error | undefined;
  for (const client of CLIENTS) {
    let parsed: PlayerResponse;
    try {
      const res = await fetchImpl(PLAYER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": client.userAgent },
        body: JSON.stringify({ videoId, contentCheckOk: true, racyCheckOk: true, context: { client: client.context } }),
      });
      if (!res.ok) {
        lastError = new TranscriptFetchError(`YouTube player request failed (HTTP ${res.status}).`);
        continue;
      }
      parsed = (await res.json()) as PlayerResponse;
    } catch (error) {
      lastError = error instanceof Error ? error : new TranscriptFetchError("YouTube player request failed.");
      continue;
    }
    const status = parsed.playabilityStatus?.status;
    // A client that has aged out answers non-OK for everything, so try the
    // next one before believing what it says about the video.
    if (status && status !== "OK") {
      lastError = playabilityFailure(status, parsed.playabilityStatus?.reason);
      continue;
    }
    return parsed;
  }
  throw lastError ?? new TranscriptFetchError("YouTube did not describe this video.");
}

/**
 * Which track to read. Auto-dubbed videos are the reason this is not simply
 * "the first English one": dubbing adds *audio* tracks, all pointing back at
 * the same caption list, and the dub a viewer hears decides which caption
 * track YouTube shows by default. So the default audio track's own choice
 * wins, then a manual track in the wanted language, then anything manual,
 * then auto-generated. There is no transcript of synthesised dub speech --
 * only the original language's captions, hence no attempt to find one.
 */
export function selectCaptionTrack(
  tracks: CaptionTrack[],
  audio: { defaultCaptionTrackIndex?: number; captionTrackIndices?: number[] }[] | undefined,
  defaultAudioIndex: number | undefined,
  preferred: string,
): CaptionTrack | undefined {
  if (tracks.length === 0) return undefined;
  const manual = (t: CaptionTrack) => t.kind !== "asr";
  const wanted = (t: CaptionTrack) => (t.languageCode ?? "").toLowerCase().startsWith(preferred);

  const chosen = audio?.[defaultAudioIndex ?? 0]?.defaultCaptionTrackIndex;
  if (chosen !== undefined && tracks[chosen]) return tracks[chosen];

  return tracks.find((t) => manual(t) && wanted(t))
    ?? tracks.find(wanted)
    ?? tracks.find(manual)
    ?? tracks[0];
}

/**
 * Ask a signed caption URL for WebVTT. `fmt` is already present on the URL
 * (as `srv3`), and a second one is ignored, so it has to be replaced rather
 * than appended. The signature covers only the parameters named in
 * `sparams`, which `fmt` is not, so rewriting it keeps the URL valid.
 */
export function captionUrlAsVtt(baseUrl: string): string {
  return /[?&]fmt=/.test(baseUrl)
    ? baseUrl.replace(/([?&])fmt=[^&]*/, "$1fmt=vtt")
    : `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}fmt=vtt`;
}

/** True for the browser-issued URLs that need a proof-of-origin token. */
function needsProofOfOrigin(baseUrl: string): boolean {
  const exp = /[?&]exp=([^&]*)/.exec(baseUrl)?.[1] ?? "";
  return exp.split(",").some((value) => value === "xpe" || value === "xpv");
}

export async function getYouTubeTranscript(
  videoId: string,
  fetchImpl: FetchLike,
  language = "en",
): Promise<TranscriptResult> {
  const player = await requestPlayer(videoId, fetchImpl);
  const renderer = player.captions?.playerCaptionsTracklistRenderer;
  const tracks = (renderer?.captionTracks ?? []).filter((t) => typeof t?.baseUrl === "string" && t.baseUrl);

  if (tracks.length === 0) {
    throw new NoTranscriptError("This YouTube video has no caption tracks available.");
  }

  const track = selectCaptionTrack(tracks, renderer?.audioTracks, renderer?.defaultAudioTrackIndex, language);
  if (!track) {
    throw new NoTranscriptError("This YouTube video has no caption tracks available.");
  }
  if (needsProofOfOrigin(track.baseUrl)) {
    throw new TranscriptFetchError(
      "YouTube issued this caption track behind a proof-of-origin check this server cannot answer, " +
        "so the captions could not be downloaded. The video may still have captions.",
    );
  }

  const res = await fetchImpl(captionUrlAsVtt(track.baseUrl));
  if (!res.ok) {
    throw new TranscriptFetchError(`YouTube caption download failed (HTTP ${res.status}).`);
  }
  const body = await res.text();
  // A caption URL that answers 200 with nothing is a refusal, not an absence:
  // the track was listed a moment ago. Saying "no captions" here is what sent
  // users looking for a transcript that was there all along.
  if (!body.trim()) {
    throw new TranscriptFetchError(
      "YouTube listed a caption track for this video but served an empty response for it. " +
        "This is usually a temporary block rather than a missing transcript; try again.",
    );
  }

  const { format, cues } = parseCaptions(body);
  if (cues.length === 0) {
    throw new TranscriptFetchError(
      "YouTube served a caption track for this video in a format that could not be read.",
    );
  }

  const lengthSeconds = Number(player.videoDetails?.lengthSeconds);
  return {
    cues,
    format,
    language: trackLabel(track) ?? track.languageCode ?? null,
    title: player.videoDetails?.title ?? null,
    durationSeconds: Number.isFinite(lengthSeconds) && lengthSeconds > 0 ? lengthSeconds : null,
  };
}
