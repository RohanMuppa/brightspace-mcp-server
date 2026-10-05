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
    origin: "https://purdue.brightspace.com",
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

describe("get_video_transcript — Brightspace LTI quickLinks", () => {
  const QUICKLINK = "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=PU-123&srcou=6606";

  function launchPage(body: string) {
    return `<html><body>${body}<script>document.forms[0].submit();</script></body></html>`;
  }

  function setupLti(pages: Record<string, string | null>) {
    const { call, apiClient } = setup(kalturaFetch(), QUICKLINK);
    const getPage = vi.fn(async (path: string) => {
      if (!(path in pages)) throw new Error(`Unexpected getPage: ${path}`);
      return pages[path];
    });
    Object.assign(apiClient, { getPage });
    return { call, getPage };
  }

  it("follows the LTI launch form to the Kaltura video and returns its transcript", async () => {
    const { call } = setupLti({
      [QUICKLINK]: launchPage(
        `<form id="LtiRequestForm" method="post" action="https://cdnapisec.kaltura.com/html5/html5lib/v2.9/mwEmbedFrame.php?wid=_123456&amp;entry_id=1_abcdefg">` +
          `<input type="hidden" name="lti_version" value="LTI-1p0" /></form>`
      ),
    });
    const body = JSON.parse((await call({ courseId: COURSE_ID, topicId: 55 })).content[0].text);

    expect(body.hasTranscript).toBe(true);
    expect(body.platform).toBe("kaltura");
    expect(body.transcript).toBe(
      "[0:00:01] Welcome back to lecture seven.\n[0:00:04] Today: pinch-off in a MOSFET."
    );
  });

  it("takes the Kaltura partner ID from the LTI consumer key when a school's KAF launch URL omits it", async () => {
    const { call } = setupLti({
      [QUICKLINK]: launchPage(
        `<form method="post" action="https://kaf.example.edu/browseandembed/index/media/entry_id/1_abcdefg">` +
          `<input type="hidden" name="oauth_consumer_key" value="123456" /></form>`
      ),
    });
    const body = JSON.parse((await call({ courseId: COURSE_ID, topicId: 55 })).content[0].text);

    expect(body.hasTranscript).toBe(true);
    expect(body.platform).toBe("kaltura");
  });

  it("follows a quickLink page that frames the Brightspace tool launch", async () => {
    const { call } = setupLti({
      [QUICKLINK]: `<html><body><iframe src="/d2l/le/lti/101/toolLaunch/77?topicId=55&amp;x=1"></iframe></body></html>`,
      "/d2l/le/lti/101/toolLaunch/77?topicId=55&x=1": launchPage(
        `<form method="post" action="https://kaf.kaltura.com/browseandembed/index/media/entry_id/1_abcdefg/wid/_123456"></form>`
      ),
    });
    const body = JSON.parse((await call({ courseId: COURSE_ID, topicId: 55 })).content[0].text);

    expect(body.hasTranscript).toBe(true);
  });

  it("says the LTI link could not be resolved when the page can't be read with the session cookie", async () => {
    const { call } = setupLti({ [QUICKLINK]: null });
    const body = JSON.parse((await call({ courseId: COURSE_ID, topicId: 55 })).content[0].text);

    expect(body.hasTranscript).toBe(false);
    expect(body.message).toMatch(/LTI link/);
  });

  it("strips D2L session params from the unresolved LTI link's videoUrl and message, but fetches the raw URL (#187)", async () => {
    const sessionLink =
      "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=fixture" +
      "&d2lSessionVal=TEST_SESSION&d2lSecureSessionVal=TEST_SECURE";
    const { call, apiClient } = setup(kalturaFetch(), sessionLink);
    const getPage = vi.fn(async () => null);
    Object.assign(apiClient, { getPage });

    const result = await call({ courseId: COURSE_ID, topicId: 55 });
    const body = JSON.parse(result.content[0].text);

    // The authenticated request still uses the URL exactly as Brightspace gave it.
    expect(getPage).toHaveBeenCalledWith(sessionLink);
    expect(result.content[0].text).not.toContain("TEST_SESSION");
    expect(result.content[0].text).not.toContain("TEST_SECURE");
    expect(body.videoUrl).toBe("/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=fixture");
    expect(body.message).toContain("ou=101&type=lti&rcode=fixture");
    expect(body.message).not.toMatch(/d2lSessionVal|d2lSecureSessionVal/i);
  });

  it("says the LTI link could not be resolved, rather than calling it an unsupported platform", async () => {
    const { call } = setupLti({
      [QUICKLINK]: launchPage(
        `<form method="post" action="https://tool.example.com/lti/login">` +
          `<input type="hidden" name="login_hint" value="abc" /></form>`
      ),
    });
    const result = await call({ courseId: COURSE_ID, topicId: 55 });
    const body = JSON.parse(result.content[0].text);

    expect(body.hasTranscript).toBe(false);
    expect(body.message).toMatch(/LTI link/);
    expect(body.message).not.toMatch(/supported video platform/);
  });
});

describe("get_video_transcript — absolute same-origin quickLinks (#190)", () => {
  const PATH = "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=FIXTURE";
  const ABSOLUTE = `https://purdue.brightspace.com${PATH}`;
  const LAUNCH =
    `<html><body><form id="LtiRequestForm" method="post" ` +
    `action="https://cdnapisec.kaltura.com/html5/html5lib/v2.9/mwEmbedFrame.php?wid=_123456&amp;entry_id=1_abcdefg">` +
    `<input type="hidden" name="lti_version" value="LTI-1p0" /></form></body></html>`;

  function setupPages(topicUrl: string | null, pages: Record<string, string | null>) {
    const { call, apiClient } = setup(kalturaFetch(), topicUrl);
    const getPage = vi.fn(async (path: string) => {
      if (!(path in pages)) throw new Error(`Unexpected getPage: ${path}`);
      return pages[path];
    });
    Object.assign(apiClient, { getPage });
    return { call, getPage };
  }

  it("resolves an absolute same-origin quickLink topic URL through the authenticated launch", async () => {
    const { call, getPage } = setupPages(ABSOLUTE, { [PATH]: LAUNCH });
    const body = JSON.parse((await call({ courseId: COURSE_ID, topicId: 55 })).content[0].text);

    expect(getPage).toHaveBeenCalledWith(PATH);
    expect(body.hasTranscript).toBe(true);
    expect(body.platform).toBe("kaltura");
  });

  it("resolves an absolute same-origin quickLink passed directly as videoUrl", async () => {
    const { call, getPage } = setupPages(null, { [PATH]: LAUNCH });
    const body = JSON.parse((await call({ videoUrl: ABSOLUTE })).content[0].text);

    expect(getPage).toHaveBeenCalledWith(PATH);
    expect(body.hasTranscript).toBe(true);
  });

  it("resolves the relative equivalent the same way", async () => {
    const { call, getPage } = setupPages(PATH, { [PATH]: LAUNCH });
    const body = JSON.parse((await call({ courseId: COURSE_ID, topicId: 55 })).content[0].text);

    expect(getPage).toHaveBeenCalledWith(PATH);
    expect(body.hasTranscript).toBe(true);
  });

  it("strips session params from an unresolved absolute quickLink but requests the raw path", async () => {
    const raw = `${ABSOLUTE}&d2lSessionVal=TEST_SESSION`;
    const { call, getPage } = setupPages(raw, { [`${PATH}&d2lSessionVal=TEST_SESSION`]: null });
    const result = await call({ courseId: COURSE_ID, topicId: 55 });
    const body = JSON.parse(result.content[0].text);

    expect(getPage).toHaveBeenCalledWith(`${PATH}&d2lSessionVal=TEST_SESSION`);
    expect(body.hasTranscript).toBe(false);
    expect(body.message).toMatch(/LTI link/);
    expect(result.content[0].text).not.toContain("TEST_SESSION");
    expect(body.videoUrl).toBe(ABSOLUTE);
  });

  it("follows an absolute same-origin tool launch framed by the quickLink page", async () => {
    const { call } = setupPages(PATH, {
      [PATH]: `<iframe src="https://purdue.brightspace.com/d2l/le/lti/101/toolLaunch/77?topicId=55"></iframe>`,
      "/d2l/le/lti/101/toolLaunch/77?topicId=55": LAUNCH,
    });
    const body = JSON.parse((await call({ courseId: COURSE_ID, topicId: 55 })).content[0].text);

    expect(body.hasTranscript).toBe(true);
  });

  it("does not follow a framed /d2l/ link on another origin", async () => {
    const { call, getPage } = setupPages(PATH, {
      [PATH]: `<iframe src="https://purdue.brightspace.com.evil.example/d2l/le/lti/101/toolLaunch/77"></iframe>`,
    });
    const body = JSON.parse((await call({ courseId: COURSE_ID, topicId: 55 })).content[0].text);

    expect(getPage).toHaveBeenCalledTimes(1);
    expect(body.hasTranscript).toBe(false);
    expect(body.message).toMatch(/LTI link/);
  });

  it.each([
    ["a lookalike host", `https://purdue.brightspace.com.evil.example${PATH}`],
    ["an http: downgrade", `http://purdue.brightspace.com${PATH}`],
    ["a userinfo trick", `https://purdue.brightspace.com@evil.example${PATH}`],
    ["a different port", `https://purdue.brightspace.com:8443${PATH}`],
    ["a different Brightspace", `https://other.brightspace.com${PATH}`],
  ])("never sends an authenticated request for a quickLink on %s", async (_label, url) => {
    const { call, getPage } = setupPages(url, {});
    const body = JSON.parse((await call({ courseId: COURSE_ID, topicId: 55 })).content[0].text);

    expect(getPage).not.toHaveBeenCalled();
    expect(body.hasTranscript).toBe(false);
    expect(body.platform).toBe("unknown");
  });
});
