import { describe, it, expect } from "vitest";
import {
  detectVideoPlatform,
  extractKalturaIds,
  extractYouTubeVideoId,
} from "../../../src/utils/transcript/platform.js";

describe("detectVideoPlatform", () => {
  it("recognizes Kaltura by hostname", () => {
    expect(detectVideoPlatform("https://cdnapisec.kaltura.com/html5/html5lib/v2.9/mwEmbedFrame.php")).toBe("kaltura");
  });

  it("recognizes a school's own Kaltura (KAF) front end by entry/partner query params", () => {
    expect(
      detectVideoPlatform("https://boilercast.purdue.edu/browseandembed/index/media/entry_id/1_abc123/wid/_456")
    ).toBe("kaltura");
  });

  it("recognizes youtube.com and youtu.be", () => {
    expect(detectVideoPlatform("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
    expect(detectVideoPlatform("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
  });

  it("recognizes panopto, yuja, echo360, and vimeo", () => {
    expect(detectVideoPlatform("https://purdue.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=1")).toBe("panopto");
    expect(detectVideoPlatform("https://school.yuja.com/V/Video?v=1")).toBe("yuja");
    expect(detectVideoPlatform("https://echo360.org/media/1/public")).toBe("echo360");
    expect(detectVideoPlatform("https://vimeo.com/12345")).toBe("vimeo");
  });

  it("returns unknown for an unrecognized or unparseable URL", () => {
    expect(detectVideoPlatform("https://example.edu/course/page.html")).toBe("unknown");
    expect(detectVideoPlatform("not a url")).toBe("unknown");
  });
});

describe("extractKalturaIds", () => {
  it("reads entry_id and wid from an mwEmbedFrame-style URL", () => {
    expect(
      extractKalturaIds(
        "https://cdnapisec.kaltura.com/html5/html5lib/v2.9/mwEmbedFrame.php?wid=_123456&entry_id=1_abcdefg"
      )
    ).toEqual({ partnerId: "123456", entryId: "1_abcdefg" });
  });

  it("reads a partner_id query param without the underscore prefix", () => {
    expect(
      extractKalturaIds("https://mediaspace.kaltura.com/embed?entryId=1_xyz&partner_id=789")
    ).toEqual({ partnerId: "789", entryId: "1_xyz" });
  });

  it("reads entry ID from a /media/t/ path segment", () => {
    expect(extractKalturaIds("https://mediaspace.kaltura.com/media/t/1_abc999?partnerId=555")).toEqual({
      partnerId: "555",
      entryId: "1_abc999",
    });
  });

  it("returns null when either ID is missing", () => {
    expect(extractKalturaIds("https://cdnapisec.kaltura.com/html5/html5lib/v2.9/mwEmbedFrame.php")).toBeNull();
    expect(extractKalturaIds("not a url")).toBeNull();
  });
});

describe("extractYouTubeVideoId", () => {
  it("reads the v= param from a watch URL", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s")).toBe("dQw4w9WgXcQ");
  });

  it("reads the path segment from a youtu.be short link", () => {
    expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("reads the path segment from an /embed/ URL", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for a non-YouTube or unparseable URL", () => {
    expect(extractYouTubeVideoId("https://vimeo.com/12345")).toBeNull();
    expect(extractYouTubeVideoId("not a url")).toBeNull();
  });
});
