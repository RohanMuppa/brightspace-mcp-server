import { describe, it, expect, vi } from "vitest";
import { registerSearchCourse, buildSnippet, rankEntries, tokenize, type SearchEntry } from "../../src/tools/search-course.js";
import { SearchCourseSchema } from "../../src/tools/schemas.js";
import { ApiError } from "../../src/api/index.js";

/**
 * search_course lets a caller find a specific module, topic, announcement, or
 * discussion post by keyword instead of reading an entire content tree. It
 * reuses the same fetchers as get_course_content, get_announcements, and
 * get_discussions (see those files), so these tests mock the same `le`/`get`
 * surface the existing tool tests do.
 */

const COURSE_ID = 55;
const MODULE_ID = 10;
const FORUM_ID = 30;

const ROOT_MODULE = {
  Id: MODULE_ID,
  Title: "Exams",
  ShortTitle: null,
  Type: 0,
  Description: null,
  ModuleStartDate: null,
  ModuleEndDate: null,
  ModuleDueDate: null,
  IsHidden: false,
  IsLocked: false,
  LastModifiedDate: null,
};

// Title match: both query terms ("midterm", "review") appear in the title.
const TOPIC_TITLE_MATCH = {
  Id: 201,
  Title: "Midterm Review Slides",
  ShortTitle: null,
  Type: 1,
  TopicType: 1,
  Description: null,
  IsHidden: false,
  IsLocked: false,
  LastModifiedDate: null,
};

// Body match: both query terms appear only in the description text.
const TOPIC_BODY_MATCH = {
  Id: 202,
  Title: "Lecture Notes",
  ShortTitle: null,
  Type: 1,
  TopicType: 1,
  Description: { Text: "These are notes about the midterm review material covered in class.", Html: "" },
  IsHidden: false,
  IsLocked: false,
  LastModifiedDate: null,
};

// Partial title match: only "midterm" appears, never "review".
const TOPIC_PARTIAL_TITLE = {
  Id: 203,
  Title: "Midterm Logistics",
  ShortTitle: null,
  Type: 1,
  TopicType: 1,
  Description: null,
  IsHidden: false,
  IsLocked: false,
  LastModifiedDate: null,
};

// All-terms body match, but in the body rather than the title — should still
// outrank TOPIC_PARTIAL_TITLE despite that one matching in the title.
const TOPIC_ALL_TERMS_BODY = {
  Id: 204,
  Title: "FAQ",
  ShortTitle: null,
  Type: 1,
  TopicType: 1,
  Description: { Text: "Please review your midterm materials carefully.", Html: "" },
  IsHidden: false,
  IsLocked: false,
  LastModifiedDate: null,
};

const NEWS_ITEMS = [
  {
    Id: 301,
    Title: "Office Hours Update",
    Body: { Text: "No midterm review session this week.", Html: "" },
    CreatedBy: { Identifier: "1", DisplayName: "Prof" },
    CreatedDate: "2026-01-01T00:00:00Z",
    LastModifiedBy: { Identifier: "1", DisplayName: "Prof" },
    LastModifiedDate: "2026-01-01T00:00:00Z",
    StartDate: "2026-01-01T00:00:00Z",
    EndDate: null,
    IsPublished: true,
    IsPinned: false,
    IsGlobal: false,
  },
];

const FORUMS = [
  {
    ForumId: FORUM_ID,
    Name: "General Discussion",
    Description: { Text: "", Html: "" },
    StartDate: null,
    EndDate: null,
    IsLocked: false,
    IsHidden: false,
    AllowAnonymous: false,
    RequiresApproval: false,
  },
];

const FORUM_TOPICS = [
  {
    ForumId: FORUM_ID,
    TopicId: 401,
    Name: "Midterm review session?",
    Description: { Text: "Is there a review session before the midterm?", Html: "" },
    StartDate: null,
    EndDate: null,
    DueDate: null,
    IsLocked: false,
    IsHidden: false,
    AllowAnonymousPosts: false,
    MustPostToParticipate: false,
    RequiresApproval: false,
    ScoreOutOf: null,
  },
];

interface Harness {
  call: (args: unknown) => Promise<any>;
}

function setup(options: {
  rootModules?: unknown[] | (() => unknown[]);
  moduleStructures?: Record<number, unknown[]>;
  news?: unknown[];
  forums?: unknown[] | (() => unknown[]);
  forumTopics?: Record<number, unknown[]>;
} = {}): Harness {
  const {
    rootModules = [ROOT_MODULE],
    moduleStructures = { [MODULE_ID]: [TOPIC_TITLE_MATCH, TOPIC_BODY_MATCH, TOPIC_PARTIAL_TITLE, TOPIC_ALL_TERMS_BODY] },
    news = NEWS_ITEMS,
    forums = FORUMS,
    forumTopics = { [FORUM_ID]: FORUM_TOPICS },
  } = options;

  const apiClient = {
    le: (id: number, p: string) => `/d2l/api/le/1.0/${id}${p}`,
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/content/root/")) {
        return typeof rootModules === "function" ? rootModules() : rootModules;
      }
      const moduleMatch = path.match(/\/content\/modules\/(\d+)\/structure\/$/);
      if (moduleMatch) {
        const id = Number(moduleMatch[1]);
        return moduleStructures[id] ?? [];
      }
      if (path.endsWith("/news/")) return news;
      if (path.endsWith("/discussions/forums/")) {
        return typeof forums === "function" ? forums() : forums;
      }
      const topicsMatch = path.match(/\/discussions\/forums\/(\d+)\/topics\/$/);
      if (topicsMatch) {
        const id = Number(topicsMatch[1]);
        return forumTopics[id] ?? [];
      }
      throw new Error(`Unexpected request: ${path}`);
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerSearchCourse(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args) };
}

describe("search_course ranking", () => {
  it("ranks a title match above a body-only match when both cover every query term", async () => {
    const { call } = setup();
    const result = await call({ courseId: COURSE_ID, query: "midterm review", limit: 50 });
    const body = JSON.parse(result.content[0].text);

    const titleHit = body.results.find((r: any) => r.id === TOPIC_TITLE_MATCH.Id);
    const bodyHit = body.results.find((r: any) => r.id === TOPIC_BODY_MATCH.Id);

    expect(titleHit).toBeDefined();
    expect(bodyHit).toBeDefined();
    expect(titleHit.score).toBeGreaterThan(bodyHit.score);
    expect(body.results.indexOf(titleHit)).toBeLessThan(body.results.indexOf(bodyHit));
  });

  it("ranks a full-coverage body match above a partial title match", async () => {
    const { call } = setup();
    const result = await call({ courseId: COURSE_ID, query: "midterm review", limit: 50 });
    const body = JSON.parse(result.content[0].text);

    const allTermsHit = body.results.find((r: any) => r.id === TOPIC_ALL_TERMS_BODY.Id);
    const partialHit = body.results.find((r: any) => r.id === TOPIC_PARTIAL_TITLE.Id);

    expect(allTermsHit).toBeDefined();
    expect(partialHit).toBeDefined();
    expect(allTermsHit.score).toBeGreaterThan(partialHit.score);
    expect(body.results.indexOf(allTermsHit)).toBeLessThan(body.results.indexOf(partialHit));
  });

  it("finds matches across content, announcements, and discussions", async () => {
    const { call } = setup();
    const result = await call({ courseId: COURSE_ID, query: "midterm review", limit: 50 });
    const body = JSON.parse(result.content[0].text);
    const kinds = new Set(body.results.map((r: any) => r.kind));

    expect(kinds.has("topic")).toBe(true);
    expect(kinds.has("announcement")).toBe(true);
    expect(kinds.has("discussion")).toBe(true);

    const topicHit = body.results.find((r: any) => r.id === TOPIC_TITLE_MATCH.Id);
    expect(topicHit.moduleTitle).toBe("Exams");
  });

  it("excludes entries that match none of the query terms", async () => {
    const { call } = setup();
    const result = await call({ courseId: COURSE_ID, query: "midterm review", limit: 50 });
    const body = JSON.parse(result.content[0].text);
    // The "Exams" module itself has no title/description match for either
    // query term, so it should never appear in results.
    expect(body.results.find((r: any) => r.kind === "module" && r.title === "Exams")).toBeUndefined();
  });
});

describe("search_course limit", () => {
  it("returns at most `limit` results, highest scoring first", async () => {
    const { call } = setup();
    const result = await call({ courseId: COURSE_ID, query: "midterm review", limit: 2 });
    const body = JSON.parse(result.content[0].text);

    expect(body.results).toHaveLength(2);
    expect(body.results[0].score).toBeGreaterThanOrEqual(body.results[1].score);
  });

  it("defaults the limit to 10 when omitted", async () => {
    const { limit } = SearchCourseSchema.parse({ courseId: COURSE_ID, query: "midterm review" });
    expect(limit).toBe(10);
  });
});

describe("search_course partial source failure", () => {
  it("reports a failing source in `note` without failing the whole search", async () => {
    const { call } = setup({
      forums: () => {
        throw new ApiError(403, "/discussions/forums/", "Forbidden");
      },
    });

    const result = await call({ courseId: COURSE_ID, query: "midterm review", limit: 50 });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);

    expect(body.note).toBeDefined();
    expect(body.note).toMatch(/discussions/i);
    // Content and announcements still searched despite discussions failing.
    expect(body.results.some((r: any) => r.kind === "topic")).toBe(true);
    expect(body.results.some((r: any) => r.kind === "announcement")).toBe(true);
    expect(body.results.some((r: any) => r.kind === "discussion")).toBe(false);
  });

  it("omits `note` entirely when every source succeeds", async () => {
    const { call } = setup();
    const result = await call({ courseId: COURSE_ID, query: "midterm review", limit: 50 });
    const body = JSON.parse(result.content[0].text);
    expect(body.note).toBeUndefined();
  });

  it("reports a failing CONTENT source in `note` while still returning announcement/discussion results", async () => {
    const { call } = setup({
      rootModules: () => {
        throw new ApiError(403, "/content/root/", "Forbidden");
      },
    });

    const result = await call({ courseId: COURSE_ID, query: "midterm review", limit: 50 });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);

    expect(body.note).toBeDefined();
    expect(body.note).toMatch(/content/i);
    // Content couldn't be searched, but announcements and discussions still were.
    expect(body.results.some((r: any) => r.kind === "topic" || r.kind === "module")).toBe(false);
    expect(body.results.some((r: any) => r.kind === "announcement")).toBe(true);
    expect(body.results.some((r: any) => r.kind === "discussion")).toBe(true);
  });
});

describe("search_course snippet windowing", () => {
  it("keeps the snippet at or under 200 characters, centered on the match", () => {
    const filler = "x".repeat(300);
    const text = `${filler} the midterm review material is right here ${filler}`;
    const matchIndex = text.toLowerCase().indexOf("midterm");

    const snippet = buildSnippet(text, matchIndex, 200);

    expect(snippet.length).toBeLessThanOrEqual(200);
    expect(snippet).toContain("midterm");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("produces a snippet via the full tool response for a long topic body", async () => {
    const longBody = {
      Id: 205,
      Title: "Appendix",
      ShortTitle: null,
      Type: 1,
      TopicType: 1,
      Description: {
        Text: `${"filler text ".repeat(40)} midterm review happens here ${"more filler ".repeat(40)}`,
        Html: "",
      },
      IsHidden: false,
      IsLocked: false,
      LastModifiedDate: null,
    };
    const { call } = setup({ moduleStructures: { [MODULE_ID]: [longBody] } });

    const result = await call({ courseId: COURSE_ID, query: "midterm review", limit: 50 });
    const body = JSON.parse(result.content[0].text);
    const hit = body.results.find((r: any) => r.id === 205);

    expect(hit).toBeDefined();
    expect(hit.snippet.length).toBeLessThanOrEqual(200);
    expect(hit.snippet.toLowerCase()).toContain("midterm");
  });
});

describe("SearchCourseSchema validation", () => {
  it("rejects a query shorter than 2 characters", () => {
    const parsed = SearchCourseSchema.safeParse({ courseId: COURSE_ID, query: "a" });
    expect(parsed.success).toBe(false);
  });

  it("accepts a 2-character query", () => {
    const parsed = SearchCourseSchema.safeParse({ courseId: COURSE_ID, query: "ab" });
    expect(parsed.success).toBe(true);
  });

  it("rejects a query longer than 200 characters", () => {
    const parsed = SearchCourseSchema.safeParse({ courseId: COURSE_ID, query: "a".repeat(201) });
    expect(parsed.success).toBe(false);
  });

  it("rejects a limit above 50", () => {
    const parsed = SearchCourseSchema.safeParse({ courseId: COURSE_ID, query: "midterm", limit: 51 });
    expect(parsed.success).toBe(false);
  });
});

describe("rankEntries (pure)", () => {
  it("returns an empty array when nothing matches", () => {
    const entries: SearchEntry[] = [{ kind: "topic", id: 1, title: "Unrelated", body: "" }];
    expect(rankEntries(entries, "midterm", 10)).toEqual([]);
  });

  it("matches an accented query against the same accented term in an entry", () => {
    const entries: SearchEntry[] = [
      { kind: "topic", id: 1, title: "Réunion du café", body: "" },
      { kind: "topic", id: 2, title: "Unrelated", body: "" },
    ];
    const results = rankEntries(entries, "café", 10);
    expect(results.map((r) => r.id)).toEqual([1]);
  });
});

describe("tokenize", () => {
  it("splits on Unicode-aware word boundaries, keeping accented letters intact", () => {
    expect(tokenize("Réunion du café")).toEqual(["réunion", "du", "café"]);
  });

  it("drops single-character residue terms", () => {
    // "l'école" splits on the apostrophe; the leftover "l" is too short to
    // carry any search signal and should be dropped.
    expect(tokenize("l'école")).toEqual(["école"]);
  });
});
