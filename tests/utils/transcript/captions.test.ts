import { describe, it, expect } from "vitest";
import { parseCaptions, formatTimestamp, cuesToText, paginateText } from "../../../src/utils/transcript/captions.js";

const WEBVTT_SAMPLE = `WEBVTT

00:00:01.000 --> 00:00:04.500
Hello and welcome to lecture seven.

00:00:04.500 --> 00:00:08.250 align:start position:0%
Today we'll cover <b>pinch-off</b> in a MOSFET.

NOTE this is a note, not a cue

00:01:02.000 --> 00:01:05.000
Any questions so far?
`;

const SRT_SAMPLE = `1
00:00:01,000 --> 00:00:04,500
Hello and welcome to lecture seven.

2
00:00:04,500 --> 00:00:08,250
Today we'll cover pinch-off in a MOSFET.
`;

describe("parseCaptions", () => {
  it("parses WebVTT cues, strips inline tags and cue settings, and skips NOTE blocks", () => {
    const { format, cues } = parseCaptions(WEBVTT_SAMPLE);

    expect(format).toBe("vtt");
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ startMs: 1000, endMs: 4500, text: "Hello and welcome to lecture seven." });
    expect(cues[1].text).toBe("Today we'll cover pinch-off in a MOSFET.");
    expect(cues[1].endMs).toBe(8250);
    expect(cues[2].startMs).toBe(62000);
  });

  it("parses SRT cues using comma decimal separators", () => {
    const { format, cues } = parseCaptions(SRT_SAMPLE);

    expect(format).toBe("srt");
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startMs: 1000, endMs: 4500, text: "Hello and welcome to lecture seven." });
  });

  it("returns no cues for text with no timing lines", () => {
    const { cues } = parseCaptions("just some text\nwith no timestamps at all");
    expect(cues).toHaveLength(0);
  });

  it("handles CRLF line endings and a leading BOM", () => {
    const withCrlf = "﻿WEBVTT\r\n\r\n00:00:00.000 --> 00:00:01.000\r\nHi\r\n";
    const { cues } = parseCaptions(withCrlf);
    expect(cues).toEqual([{ startMs: 0, endMs: 1000, text: "Hi" }]);
  });
});

describe("formatTimestamp", () => {
  it("formats sub-hour durations as H:MM:SS", () => {
    expect(formatTimestamp(4500)).toBe("0:00:04");
    expect(formatTimestamp(62000)).toBe("0:01:02");
  });

  it("formats durations over an hour", () => {
    expect(formatTimestamp(3661000)).toBe("1:01:01");
  });
});

describe("cuesToText", () => {
  it("joins cues into one timestamped line each", () => {
    const { cues } = parseCaptions(WEBVTT_SAMPLE);
    const text = cuesToText(cues);
    expect(text).toBe(
      "[0:00:01] Hello and welcome to lecture seven.\n" +
        "[0:00:04] Today we'll cover pinch-off in a MOSFET.\n" +
        "[0:01:02] Any questions so far?"
    );
  });
});

describe("paginateText", () => {
  const text = "0123456789";

  it("returns the whole text untruncated when it fits", () => {
    const page = paginateText(text, 0, 100);
    expect(page).toEqual({ window: text, truncated: false, nextOffset: null, totalChars: 10 });
  });

  it("truncates and reports the next offset when it doesn't fit", () => {
    const page = paginateText(text, 0, 4);
    expect(page).toEqual({ window: "0123", truncated: true, nextOffset: 4, totalChars: 10 });
  });

  it("resumes from a given offset", () => {
    const page = paginateText(text, 4, 4);
    expect(page).toEqual({ window: "4567", truncated: true, nextOffset: 8, totalChars: 10 });
  });

  it("reaches the end with no next offset", () => {
    const page = paginateText(text, 8, 4);
    expect(page).toEqual({ window: "89", truncated: false, nextOffset: null, totalChars: 10 });
  });
});
