import { describe, it, expect, vi } from "vitest";
import { registerGetVideoTranscript } from "../../src/tools/get-video-transcript.js";
import type { FetchLike } from "../../src/utils/transcript/types.js";

const COURSE_ID = 101;
const KALTURA_URL =
  "https://cdnapisec.kaltura.com/html5/html5lib/v2.9/mwEmbedFrame.php?wid=_123456&entry_id=1_abcdefg";

const KALTURA_WEBVTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Welcome back to lecture seven.

00:00:04.000 --> 00:00:08.000
Today: pinch-off in a MOSFET.
`;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function textResponse(body: string) {
  return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
}

/** A fetch stub that answers the Kaltura widget-session/caption-list/serve/media-get sequence. */
function kalturaFetch(overrides: Partial<{ captionAssets: unknown[]; captionText: string }> = {}): FetchLike {
  const captionAssets = overrides.captionAssets ?? [{ id: "cap1", languageCode: "en", isDefault: true }];
  const captionText = overrides.captionText ?? KALTURA_WEBVTT;

  return vi.fn(async (url: string) => {
    if (url.includes("session/action/startWidgetSession")) return jsonResponse({ ks: "widget-ks-token" });
    if (url.includes("caption_captionasset/action/list")) return jsonResponse({ objects: captionAssets });
    if (url.includes("caption_captionasset/action/serve")) return textResponse(captionText);
    if (url.includes("media/action/get")) return jsonResponse({ name: "Lecture 7", duration: 3000 });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as FetchLike;
}

function setup(fetchImpl: FetchLike, topicUrl: string | null = KALTURA_URL) {
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async () => ({ Id: 55, Title: "Lecture 7 recording", Url: topicUrl })),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetVideoTranscript(server as any, apiClient as any, fetchImpl);
  return { call: (args: unknown) => handler!(args), apiClient };
}

describe("get_video_transcript — Kaltura", () => {
  it("returns the transcript with timestamps, title, and duration for a Kaltura topic", async () => {
    const { call } = setup(kalturaFetch());
    const result = await call({ courseId: COURSE_ID, topicId: 55 });
    const body = JSON.parse(result.content[0].text);

    expect(body.hasTranscript).toBe(true);
    expect(body.platform).toBe("kaltura");
    expect(body.title).toBe("Lecture 7");
    expect(body.durationSeconds).toBe(3000);
    expect(body.language).toBe("en");
    expect(body.transcript).toBe(
      "[0:00:01] Welcome back to lecture seven.\n[0:00:04] Today: pinch-off in a MOSFET."
    );
    expect(body.truncated).toBe(false);
  });

  it("explains clearly when the video has no captions, instead of an empty result", async () => {
    const { call } = setup(kalturaFetch({ captionAssets: [] }));
    const result = await call({ courseId: COURSE_ID, topicId: 55 });
    const body = JSON.parse(result.content[0].text);

    expect(body.hasTranscript).toBe(false);
    expect(body.message).toMatch(/no captions/i);
    expect(result.isError).toBeUndefined();
  });

  it("pages a long transcript across multiple calls via offset/nextOffset", async () => {
    const { call } = setup(kalturaFetch());

    const first = JSON.parse((await call({ courseId: COURSE_ID, topicId: 55, maxChars: 20 })).content[0].text);
    expect(first.truncated).toBe(true);
    expect(first.transcript).toHaveLength(20);
    expect(first.nextOffset).toBe(20);

    let assembled = first.transcript;
    let offset = first.nextOffset;
    while (offset !== null) {
      const page = JSON.parse(
        (await call({ courseId: COURSE_ID, topicId: 55, maxChars: 20, offset })).content[0].text
      );
      assembled += page.transcript;
      offset = page.nextOffset;
    }

    expect(assembled).toBe("[0:00:01] Welcome back to lecture seven.\n[0:00:04] Today: pinch-off in a MOSFET.");
  });
});

describe("get_video_transcript — unsupported and unresolved cases", () => {
  it("names the platform when it isn't supported yet", async () => {
    const { call } = setup(kalturaFetch(), null);
    const result = await call({ videoUrl: "https://purdue.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=1" });
    const body = JSON.parse(result.content[0].text);

    expect(body.hasTranscript).toBe(false);
    expect(body.platform).toBe("panopto");
    expect(body.message).toMatch(/Panopto/);
  });

  it("gives a clear message when the content topic has no URL to resolve", async () => {
    const { call } = setup(kalturaFetch(), null);
    const result = await call({ courseId: COURSE_ID, topicId: 55 });
    const body = JSON.parse(result.content[0].text);

    expect(body.hasTranscript).toBe(false);
    expect(body.message).toMatch(/no URL/i);
  });

  it("requires either videoUrl or courseId+topicId", async () => {
    const { call } = setup(kalturaFetch());
    const result = await call({});
    expect(result.isError).toBe(true);
  });
});
