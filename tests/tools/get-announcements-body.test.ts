import { describe, it, expect, vi } from "vitest";
import { mapNewsItem, registerGetAnnouncements, type NewsItem } from "../../src/tools/get-announcements.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * D2L's RichText is { Text, Html }. Text is only "the plaintext form of the
 * text": it carries no link targets, and the docs promise neither that it is
 * present nor that it matches Html. A post such as "Time to run!" lists
 * opportunities whose details live behind links, so reading Text alone hands
 * the model a list with the URLs (and any date on the linked page) missing.
 * The body must come from Html, converted to markdown, with Text as the
 * fallback only when there is no Html.
 */

const item = (body: NewsItem["Body"], extra: Partial<NewsItem> = {}): NewsItem => ({
  Id: 1,
  Title: "Time to run!",
  Body: body,
  CreatedBy: { Identifier: "1", DisplayName: "Prof" },
  CreatedDate: "2026-10-01T00:00:00.000Z",
  LastModifiedBy: { Identifier: "1", DisplayName: "Prof" },
  LastModifiedDate: "2026-10-01T00:00:00.000Z",
  StartDate: "2026-10-01T00:00:00.000Z",
  EndDate: null,
  IsPinned: false,
  IsGlobal: false,
  ...extra,
});

const OPPORTUNITIES_HTML = [
  "<p><strong>Time to run!</strong> Seven opportunities:</p>",
  "<ol>",
  '<li><strong>Rice Business Plan Competition</strong> &ndash; applications open Nov&nbsp;9, details on the <a href="https://alliance.rice.edu/rbpc?d2lSessionVal=SECRET123">program page</a></li>',
  "<li>Burton D. Morgan Competition<ul><li>Round 1: Oct 30</li><li>Round 2: Dec 4</li></ul></li>",
  "<li>Elevator pitch night<br>Room 101<br>6pm</li>",
  "</ol>",
  "<table><tr><th>Event</th><th>Close date</th></tr><tr><td>Rice</td><td>Jan 15</td></tr></table>",
  "<hr>",
  "<p>Questions? Email me.</p>",
].join("");

// What D2L's plaintext rendering looks like: tags gone, link targets gone.
const OPPORTUNITIES_TEXT =
  "Time to run! Seven opportunities: Rice Business Plan Competition - applications open Nov 9, details on the program page Burton D. Morgan Competition Round 1: Oct 30 Round 2: Dec 4 Elevator pitch night Room 101 6pm Event Close date Rice Jan 15 Questions? Email me.";

describe("mapNewsItem body", () => {
  it("keeps link targets that D2L's plain Text drops", () => {
    const { body } = mapNewsItem(item({ Text: OPPORTUNITIES_TEXT, Html: OPPORTUNITIES_HTML }));
    expect(body).toContain("(https://alliance.rice.edu/rbpc)");
    expect(body).toContain("[program page]");
  });

  it("does not echo a D2L session token from an in-body link", () => {
    const { body } = mapNewsItem(item({ Text: OPPORTUNITIES_TEXT, Html: OPPORTUNITIES_HTML }));
    expect(body).not.toContain("SECRET123");
  });

  it("keeps every list item, nested items, line breaks, tables and content after a rule", () => {
    const { body } = mapNewsItem(item({ Text: OPPORTUNITIES_TEXT, Html: OPPORTUNITIES_HTML }));
    for (const fragment of [
      "Rice Business Plan Competition",
      "Burton D. Morgan Competition",
      "Round 1: Oct 30",
      "Round 2: Dec 4",
      "Elevator pitch night",
      "Room 101",
      "6pm",
      "| Event | Close date |",
      "| Rice | Jan 15 |",
      "Questions? Email me.",
    ]) {
      expect(body).toContain(fragment);
    }
  });

  it("uses Html when Text is empty or shorter than the post", () => {
    expect(mapNewsItem(item({ Text: "", Html: "<p>Apply by <b>Jan 15</b></p>" })).body).toBe("Apply by **Jan 15**");
    expect(mapNewsItem(item({ Text: "Apply by", Html: "<p>Apply by Jan 15</p>" })).body).toBe("Apply by Jan 15");
  });

  it("falls back to Text when Html is null, empty, or whitespace", () => {
    expect(mapNewsItem(item({ Text: "Plain only", Html: null as any })).body).toBe("Plain only");
    expect(mapNewsItem(item({ Text: "Plain only", Html: "" })).body).toBe("Plain only");
    expect(mapNewsItem(item({ Text: "Plain only", Html: "  \n " })).body).toBe("Plain only");
    expect(mapNewsItem(item({ Text: "Plain only" } as any)).body).toBe("Plain only");
  });

  it("falls back to Text when Html holds markup with no readable content", () => {
    expect(mapNewsItem(item({ Text: "Plain only", Html: "<div><br></div>" })).body).toBe("Plain only");
  });

  it("is an empty string when there is no body at all", () => {
    expect(mapNewsItem(item(null)).body).toBe("");
  });

  it("leaves the announcement shape unchanged", () => {
    expect(Object.keys(mapNewsItem(item({ Text: "x", Html: "<p>x</p>" }))).sort()).toEqual(
      ["body", "createdBy", "date", "id", "isPinned", "lastModified", "title"]
    );
  });
});

describe("get_announcements handler body", () => {
  it("returns the Html-derived body, with links, for a course", async () => {
    const apiClient = {
      lp: (p: string) => p,
      le: (id: number, p: string) => `/d2l/api/le/1.0/${id}${p}`,
      get: vi.fn(async () => [item({ Text: OPPORTUNITIES_TEXT, Html: OPPORTUNITIES_HTML })]),
    };
    let handler: (args: unknown) => Promise<any>;
    registerGetAnnouncements(
      { registerTool: (_n: string, _m: unknown, fn: any) => { handler = fn; } } as any,
      apiClient as any,
      { courseFilter: { activeOnly: true } } as AppConfig
    );
    const result = await handler!({ courseId: 101 });
    const [announcement] = JSON.parse(result.content[0].text);
    expect(announcement.body).toContain("https://alliance.rice.edu/rbpc");
    expect(announcement.body).toContain("Questions? Email me.");
  });
});
