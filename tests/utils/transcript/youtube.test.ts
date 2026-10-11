import { describe, expect, it, vi } from "vitest";
import { getYouTubeTranscript, selectCaptionTrack, captionUrlAsVtt } from "../../../src/utils/transcript/youtube.js";
import { NoTranscriptError, TranscriptFetchError } from "../../../src/utils/transcript/errors.js";
import type { FetchLike } from "../../../src/utils/transcript/types.js";

const PLAYER = "youtubei/v1/player";

/** A signed caption URL in the shape YouTube actually returns. */
const signed = (lang: string, exp = "xpo") =>
  `https://www.youtube.com/api/timedtext?v=vid&ei=abc&caps=asr&exp=${exp}&hl=en&ip=0.0.0.0`
  + `&expire=9999999999&sparams=ip,ipbits,expire,v,ei,caps&signature=DEAD&key=yt8&lang=${lang}&fmt=srv3`;

const VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:03.000
hello there

00:00:03.000 --> 00:00:05.000
second line
`;

function stub(opts: {
  player?: unknown;
  playerOk?: boolean;
  caption?: string;
  captionOk?: boolean;
  perClient?: unknown[];
}): { fetchImpl: FetchLike; calls: Array<{ url: string; method?: string }> } {
  const calls: Array<{ url: string; method?: string }> = [];
  let clientIndex = 0;
  const fetchImpl = vi.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method });
    if (url.includes(PLAYER)) {
      // Clamp: a test may run the whole flow twice, and the queue must not
      // run dry and hand back undefined.
      const queue = opts.perClient;
      const body = queue ? queue[Math.min(clientIndex++, queue.length - 1)] : opts.player;
      return {
        ok: opts.playerOk !== false,
        status: opts.playerOk === false ? 500 : 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }
    return {
      ok: opts.captionOk !== false,
      status: opts.captionOk === false ? 429 : 200,
      json: async () => ({}),
      text: async () => opts.caption ?? "",
    };
  });
  return { fetchImpl: fetchImpl as unknown as FetchLike, calls };
}

const playerWith = (tracks: unknown[], extra: Record<string, unknown> = {}) => ({
  playabilityStatus: { status: "OK" },
  videoDetails: { title: "Lecture 7", lengthSeconds: "3000" },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks, ...extra } },
});

describe("YouTube transcripts", () => {
  it("asks the InnerTube player endpoint, not the retired timedtext list", async () => {
    const { fetchImpl, calls } = stub({
      player: playerWith([{ baseUrl: signed("en"), languageCode: "en" }]),
      caption: VTT,
    });
    await getYouTubeTranscript("vid", fetchImpl);

    expect(calls[0].url).toContain(PLAYER);
    expect(calls[0].method).toBe("POST");
    expect(calls.some((c) => c.url.includes("type=list"))).toBe(false);
  });

  /*
   * The bug this file exists for. The old code listed tracks through
   * `timedtext?type=list`, which answers 200 with an empty body for every
   * video, and reported that as "this video has no caption tracks" -- a
   * successful, non-error answer. An empty body after a track was listed is a
   * refusal and has to surface as a failure, or the user is told a transcript
   * does not exist when it does.
   */
  it("treats an empty caption body as a failure, never as 'no captions exist'", async () => {
    const { fetchImpl } = stub({
      player: playerWith([{ baseUrl: signed("en"), languageCode: "en" }]),
      caption: "   ",
    });
    await expect(getYouTubeTranscript("vid", fetchImpl)).rejects.toThrow(TranscriptFetchError);
    await expect(getYouTubeTranscript("vid", fetchImpl)).rejects.not.toThrow(NoTranscriptError);
  });

  it("reports no transcript only when the player lists no tracks at all", async () => {
    const { fetchImpl } = stub({ player: playerWith([]) });
    await expect(getYouTubeTranscript("vid", fetchImpl)).rejects.toThrow(NoTranscriptError);
  });

  it("replaces the URL's own fmt instead of appending a second one", () => {
    const url = captionUrlAsVtt(signed("en"));
    expect(url).toContain("fmt=vtt");
    expect(url).not.toContain("fmt=srv3");
    expect(url.match(/fmt=/g)).toHaveLength(1);
  });

  it("refuses a browser-issued URL that needs a proof-of-origin token", async () => {
    const { fetchImpl } = stub({
      player: playerWith([{ baseUrl: signed("en", "xpe"), languageCode: "en" }]),
      caption: VTT,
    });
    await expect(getYouTubeTranscript("vid", fetchImpl)).rejects.toThrow(/proof-of-origin/i);
  });

  it("says a sign-in was demanded rather than claiming there are no captions", async () => {
    const blocked = { playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" } };
    const { fetchImpl } = stub({ perClient: [blocked, blocked] });
    await expect(getYouTubeTranscript("vid", fetchImpl)).rejects.toThrow(TranscriptFetchError);
    await expect(getYouTubeTranscript("vid", fetchImpl)).rejects.toThrow(/sign-in/i);
  });

  it("falls back to the next client when the first one is refused", async () => {
    const { fetchImpl } = stub({
      perClient: [
        { playabilityStatus: { status: "UNPLAYABLE", reason: "The page needs to be reloaded." } },
        playerWith([{ baseUrl: signed("en"), languageCode: "en" }]),
      ],
      caption: VTT,
    });
    const result = await getYouTubeTranscript("vid", fetchImpl);
    expect(result.cues).toHaveLength(2);
  });

  it("parses the timedtext XML a caption URL serves when it ignores fmt", async () => {
    const xml = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>'
      + '<p t="1360" d="1680">We&#39;re no strangers</p><p t="3040" d="1000">to love</p></body></timedtext>';
    const { fetchImpl } = stub({
      player: playerWith([{ baseUrl: signed("en"), languageCode: "en" }]),
      caption: xml,
    });
    const result = await getYouTubeTranscript("vid", fetchImpl);

    expect(result.format).toBe("timedtext");
    expect(result.cues[0]).toEqual({ startMs: 1360, endMs: 3040, text: "We're no strangers" });
  });

  it("carries the track's own label and the video's length through", async () => {
    const { fetchImpl } = stub({
      player: playerWith([
        { baseUrl: signed("en"), languageCode: "en", kind: "asr", name: { runs: [{ text: "English (auto-generated)" }] } },
      ]),
      caption: VTT,
    });
    const result = await getYouTubeTranscript("vid", fetchImpl);

    expect(result.language).toBe("English (auto-generated)");
    expect(result.title).toBe("Lecture 7");
    expect(result.durationSeconds).toBe(3000);
  });
});

describe("choosing a caption track", () => {
  const manualEn = { baseUrl: "u1", languageCode: "en" };
  const asrEn = { baseUrl: "u2", languageCode: "en", kind: "asr" };
  const manualDe = { baseUrl: "u3", languageCode: "de-DE" };

  it("prefers a human-written track over an auto-generated one", () => {
    expect(selectCaptionTrack([asrEn, manualEn], undefined, undefined, "en")).toBe(manualEn);
  });

  /*
   * Auto-dubbing adds audio tracks, not caption tracks: every dub points back
   * at the same caption list, and the dub being played decides which caption
   * track YouTube shows. Honour that choice, or a dubbed video hands back a
   * language the viewer is not listening to.
   */
  it("honours the default audio track's own caption choice on a dubbed video", () => {
    const audio = [{ defaultCaptionTrackIndex: 0 }, { defaultCaptionTrackIndex: 2 }];
    expect(selectCaptionTrack([asrEn, manualEn, manualDe], audio, 1, "en")).toBe(manualDe);
  });

  it("falls back to the wanted language, then to anything", () => {
    expect(selectCaptionTrack([manualDe, asrEn], undefined, undefined, "en")).toBe(asrEn);
    expect(selectCaptionTrack([manualDe], undefined, undefined, "en")).toBe(manualDe);
    expect(selectCaptionTrack([], undefined, undefined, "en")).toBeUndefined();
  });
});
