import { describe, expect, it, vi } from "vitest";
import { getKalturaTranscript } from "../../../src/utils/transcript/kaltura.js";
import { NoTranscriptError, TranscriptFetchError } from "../../../src/utils/transcript/errors.js";
import { parseCaptions } from "../../../src/utils/transcript/captions.js";
import type { FetchLike } from "../../../src/utils/transcript/types.js";

const SRT = "1\n00:00:01,000 --> 00:00:03,000\nhello\n";

function stub(routes: Record<string, unknown>): FetchLike {
  return vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : {};
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  }) as unknown as FetchLike;
}

const SESSION = { "action/startWidgetSession": { ks: "ks-token" } };

describe("Kaltura failures are not reported as missing captions", () => {
  /*
   * format=1 returns a TOP-LEVEL KalturaAPIException, not a nested `error`.
   * Only `data.error` was checked, so a refusal left `objects` undefined,
   * read as an empty list, and surfaced as "this video has no captions" --
   * a successful answer for a lecture that is in fact captioned.
   */
  it("surfaces a top-level KalturaAPIException instead of claiming no captions", async () => {
    const fetchImpl = stub({
      ...SESSION,
      "captionasset/action/list": { objectType: "KalturaAPIException", code: "ENTRY_ID_NOT_FOUND", message: "Entry id not found" },
    });
    await expect(getKalturaTranscript("123", "entry", fetchImpl)).rejects.toThrow(TranscriptFetchError);
    await expect(getKalturaTranscript("123", "entry", fetchImpl)).rejects.toThrow(/Entry id not found/);
  });

  it("treats a malformed list as a failure but a real empty list as no captions", async () => {
    const malformed = stub({ ...SESSION, "captionasset/action/list": { unexpected: true } });
    await expect(getKalturaTranscript("123", "entry", malformed)).rejects.toThrow(TranscriptFetchError);

    const empty = stub({ ...SESSION, "captionasset/action/list": { objects: [] } });
    await expect(getKalturaTranscript("123", "entry", empty)).rejects.toThrow(NoTranscriptError);
  });

  it("treats an empty served caption body as a failure, not an absent transcript", async () => {
    const fetchImpl = stub({
      ...SESSION,
      "captionasset/action/list": { objects: [{ id: "a1", isDefault: true }] },
      "captionasset/action/serve": "   ",
    });
    await expect(getKalturaTranscript("123", "entry", fetchImpl)).rejects.toThrow(TranscriptFetchError);
    await expect(getKalturaTranscript("123", "entry", fetchImpl)).rejects.not.toThrow(NoTranscriptError);
  });

  it("falls through to a usable asset when the default one is empty", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      let text = "{}";
      if (url.includes("startWidgetSession")) text = JSON.stringify({ ks: "k" });
      else if (url.includes("captionasset/action/list")) {
        text = JSON.stringify({ objects: [{ id: "stale", isDefault: true }, { id: "good" }] });
      } else if (url.includes("captionasset/action/serve")) {
        text = call++ === 0 ? "not caption data at all" : SRT;
      } else if (url.includes("media/action/get")) text = JSON.stringify({ name: "Lecture 7", duration: 100 });
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    }) as unknown as FetchLike;

    const result = await getKalturaTranscript("123", "entry", fetchImpl);
    expect(result.cues).toHaveLength(1);
    expect(result.title).toBe("Lecture 7");
  });
});

describe("TTML/DFXP, which Kaltura serves for many caption assets", () => {
  it("reads begin/end clock values", () => {
    const ttml = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="00:00:01.500" end="00:00:03.000">first line</p>
      <p begin="00:00:03.000" end="00:00:05.250">second &amp; last</p>
    </div></body></tt>`;
    const { format, cues } = parseCaptions(ttml);

    expect(format).toBe("timedtext");
    expect(cues).toEqual([
      { startMs: 1500, endMs: 3000, text: "first line" },
      { startMs: 3000, endMs: 5250, text: "second & last" },
    ]);
  });

  it("reads offset time expressions and a dur attribute", () => {
    const ttml = '<tt><body><p begin="1.5s" dur="2s">offset form</p>'
      + '<p begin="4000ms" end="6000ms">millis form</p></body></tt>';
    const { cues } = parseCaptions(ttml);

    expect(cues[0]).toEqual({ startMs: 1500, endMs: 3500, text: "offset form" });
    expect(cues[1]).toEqual({ startMs: 4000, endMs: 6000, text: "millis form" });
  });
});

describe("caption text fidelity", () => {
  it("keeps literal angle brackets that are not caption tags", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nif x < y and y > z then\n";
    expect(parseCaptions(vtt).cues[0].text).toBe("if x < y and y > z then");
  });

  it("still strips real caption tags and decodes entities", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<c.colorE5E5E5>We&#39;re</c> <b>here</b>\n";
    expect(parseCaptions(vtt).cues[0].text).toBe("We're here");
  });

  it("collapses the rolling repeats of an auto-generated track", () => {
    const vtt = [
      "WEBVTT", "",
      "00:00:01.000 --> 00:00:02.000", "the quick brown", "",
      "00:00:02.000 --> 00:00:03.000", "the quick brown fox", "",
      "00:00:03.000 --> 00:00:04.000", "jumps over", "",
    ].join("\n");
    const { cues } = parseCaptions(vtt);

    expect(cues.map((c) => c.text)).toEqual(["the quick brown fox", "jumps over"]);
    expect(cues[0].endMs).toBe(3000);
  });
});
