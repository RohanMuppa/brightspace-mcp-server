import { describe, it, expect, vi } from "vitest";
import { registerGetAnnouncements } from "../../src/tools/get-announcements.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * get_announcements used to show every news item the API returned, sorted by
 * CreatedDate. Both are wrong against a live tenant: an item with
 * IsPublished false is a draft the instructor has not posted, and CreatedDate
 * is when the instructor started typing, not when the post was scheduled to
 * appear. StartDate is the honest date whenever there is one.
 *
 * Both rules have to hold on the single-course path and the all-courses path,
 * which sort and slice at separate call sites.
 */

const BASE = "https://brightspace.example.edu";

const COURSE_A = { Id: 101, Name: "CS 180", Code: "cs180" };
const COURSE_B = { Id: 202, Name: "MA 261", Code: "ma261" };

function makeConfig(): AppConfig {
  return {
    baseUrl: BASE,
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly: true },
  } as AppConfig;
}

type Responder = (path: string) => unknown;

/** Captures the registered handler; `respond` maps a request path to its payload. */
function setup(respond: Responder, config: AppConfig = makeConfig()) {
  const requested: string[] = [];
  const apiClient = {
    lp: (p: string) => `/d2l/api/lp/1.0${p}`,
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return respond(path);
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_name: string, _meta: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetAnnouncements(server as any, apiClient as any, config);
  return { call: (args: unknown) => handler!(args), requested };
}

const enrollments = (...courses: Array<typeof COURSE_A>) => ({
  Items: courses.map((c) => ({
    OrgUnit: c,
    Access: { ClasslistRoleName: "Student", IsActive: true, LastAccessed: null },
  })),
});

const parse = (result: any): any[] => JSON.parse(result.content[0].text);

/** A news item with only the fields a case cares about; the rest are D2L's usual shape. */
const news = (item: Record<string, unknown>) => ({
  Title: "Announcement",
  Body: { Text: "body", Html: "<p>body</p>" },
  CreatedBy: { Identifier: "1", DisplayName: "Prof" },
  LastModifiedBy: { Identifier: "1", DisplayName: "Prof" },
  LastModifiedDate: "2026-09-01T00:00:00.000Z",
  EndDate: null,
  IsPinned: false,
  IsGlobal: false,
  Attachments: [],
  ...item,
});

/** Serves one course's news on the single-course path. */
const oneCourse = (items: unknown[]) => () => items;

/** Serves enrollments plus a per-course news payload on the all-courses path. */
const manyCourses = (byCourse: Record<number, unknown[]>): Responder => (path) => {
  if (path.includes("/enrollments/")) {
    return enrollments(...Object.keys(byCourse).map((id) => (Number(id) === COURSE_A.Id ? COURSE_A : COURSE_B)));
  }
  const match = path.match(/\/le\/1\.0\/(\d+)\//);
  return match ? byCourse[Number(match[1])] ?? [] : [];
};

describe("get_announcements", () => {
  describe("unpublished drafts", () => {
    it("excludes an item with IsPublished false", async () => {
      const { call } = setup(
        oneCourse([
          news({ Id: 1, Title: "Posted", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", IsPublished: true }),
          news({ Id: 2, Title: "Draft", CreatedDate: "2026-09-02T00:00:00.000Z", StartDate: "2026-09-02T00:00:00.000Z", IsPublished: false }),
        ])
      );

      const items = parse(await call({ courseId: COURSE_A.Id }));
      expect(items.map((i) => i.title)).toEqual(["Posted"]);
    });

    it("keeps an item that carries no IsPublished field at all", async () => {
      const { call } = setup(
        oneCourse([
          news({ Id: 1, Title: "No flag", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z" }),
        ])
      );

      const items = parse(await call({ courseId: COURSE_A.Id }));
      expect(items.map((i) => i.title)).toEqual(["No flag"]);
    });

    it("keeps an item with IsPublished true", async () => {
      const { call } = setup(
        oneCourse([
          news({ Id: 1, Title: "Posted", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", IsPublished: true }),
        ])
      );

      const items = parse(await call({ courseId: COURSE_A.Id }));
      expect(items.map((i) => i.title)).toEqual(["Posted"]);
    });
  });

  describe("scheduled-date ordering", () => {
    it("sorts by StartDate even when CreatedDate would give the opposite order", async () => {
      // Written Friday, scheduled for Monday; written Saturday, scheduled for Sunday.
      const writtenFriday = news({
        Id: 1,
        Title: "Scheduled Monday",
        CreatedDate: "2026-09-04T09:00:00.000Z",
        StartDate: "2026-09-07T09:00:00.000Z",
        IsPublished: true,
      });
      const writtenSaturday = news({
        Id: 2,
        Title: "Scheduled Sunday",
        CreatedDate: "2026-09-05T09:00:00.000Z",
        StartDate: "2026-09-06T09:00:00.000Z",
        IsPublished: true,
      });

      const { call } = setup(oneCourse([writtenFriday, writtenSaturday]));
      const items = parse(await call({ courseId: COURSE_A.Id }));

      expect(items.map((i) => i.title)).toEqual(["Scheduled Monday", "Scheduled Sunday"]);
      expect(items.map((i) => i.date)).toEqual([
        "2026-09-07T09:00:00.000Z",
        "2026-09-06T09:00:00.000Z",
      ]);
      // CreatedDate alone would have put the Saturday item first.
      expect(items[0].createdDate).toBe("2026-09-04T09:00:00.000Z");
    });

    it("falls back to CreatedDate when an item has no StartDate", async () => {
      const { call } = setup(
        oneCourse([
          news({ Id: 1, Title: "No start", CreatedDate: "2026-09-10T00:00:00.000Z", StartDate: null, IsPublished: true }),
          news({ Id: 2, Title: "Scheduled", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-05T00:00:00.000Z", IsPublished: true }),
        ])
      );

      const items = parse(await call({ courseId: COURSE_A.Id }));
      expect(items.map((i) => i.title)).toEqual(["No start", "Scheduled"]);
      expect(items[0].date).toBe("2026-09-10T00:00:00.000Z");
    });

    it("sorts an item with neither date last, not to 1970", async () => {
      const { call } = setup(
        oneCourse([
          news({ Id: 1, Title: "Undated", CreatedDate: null, StartDate: null, IsPublished: true }),
          news({ Id: 2, Title: "Oldest real", CreatedDate: "2020-01-01T00:00:00.000Z", StartDate: null, IsPublished: true }),
          news({ Id: 3, Title: "Newest real", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: null, IsPublished: true }),
        ])
      );

      const items = parse(await call({ courseId: COURSE_A.Id }));
      expect(items.map((i) => i.title)).toEqual(["Newest real", "Oldest real", "Undated"]);
      expect(items[2].date).toBeNull();
    });

    it("keeps the server's own order when two items share a date", async () => {
      const same = "2026-09-01T12:00:00.000Z";
      const { call } = setup(
        oneCourse([
          news({ Id: 1, Title: "First posted", CreatedDate: same, StartDate: same, IsPublished: true }),
          news({ Id: 2, Title: "Second posted", CreatedDate: same, StartDate: same, IsPublished: true }),
        ])
      );

      const items = parse(await call({ courseId: COURSE_A.Id }));
      expect(items.map((i) => i.title)).toEqual(["First posted", "Second posted"]);
    });
  });

  it("applies the count slice after filtering and sorting", async () => {
    const { call } = setup(
      oneCourse([
        news({ Id: 1, Title: "Draft newest", CreatedDate: "2026-09-09T00:00:00.000Z", StartDate: "2026-09-09T00:00:00.000Z", IsPublished: false }),
        news({ Id: 2, Title: "Third", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", IsPublished: true }),
        news({ Id: 3, Title: "First", CreatedDate: "2026-09-08T00:00:00.000Z", StartDate: "2026-09-08T00:00:00.000Z", IsPublished: true }),
        news({ Id: 4, Title: "Second", CreatedDate: "2026-09-05T00:00:00.000Z", StartDate: "2026-09-05T00:00:00.000Z", IsPublished: true }),
      ])
    );

    const items = parse(await call({ courseId: COURSE_A.Id, count: 2 }));
    // The draft is gone before the slice, so the cap is spent on real posts.
    expect(items.map((i) => i.title)).toEqual(["First", "Second"]);
  });

  describe("the all-courses path", () => {
    it("filters drafts and sorts by StartDate across courses", async () => {
      const { call } = setup(
        manyCourses({
          [COURSE_A.Id]: [
            news({ Id: 1, Title: "A draft", CreatedDate: "2026-09-09T00:00:00.000Z", StartDate: "2026-09-09T00:00:00.000Z", IsPublished: false }),
            news({ Id: 2, Title: "A scheduled Monday", CreatedDate: "2026-09-04T00:00:00.000Z", StartDate: "2026-09-07T00:00:00.000Z", IsPublished: true }),
          ],
          [COURSE_B.Id]: [
            news({ Id: 3, Title: "B scheduled Sunday", CreatedDate: "2026-09-05T00:00:00.000Z", StartDate: "2026-09-06T00:00:00.000Z", IsPublished: true }),
            news({ Id: 4, Title: "B no flag", CreatedDate: "2026-09-02T00:00:00.000Z", StartDate: null, IsPublished: undefined }),
          ],
        })
      );

      const items = parse(await call({}));
      expect(items.map((i) => i.title)).toEqual([
        "A scheduled Monday",
        "B scheduled Sunday",
        "B no flag",
      ]);
      expect(items[0]).toMatchObject({ courseId: COURSE_A.Id, courseName: COURSE_A.Name });
      expect(items[2]).toMatchObject({ courseId: COURSE_B.Id, date: "2026-09-02T00:00:00.000Z" });
    });

    it("sorts an undated item last and honours count across courses", async () => {
      const { call } = setup(
        manyCourses({
          [COURSE_A.Id]: [
            news({ Id: 1, Title: "A undated", CreatedDate: null, StartDate: null, IsPublished: true }),
            news({ Id: 2, Title: "A newest", CreatedDate: "2026-09-08T00:00:00.000Z", StartDate: null, IsPublished: true }),
          ],
          [COURSE_B.Id]: [
            news({ Id: 3, Title: "B middle", CreatedDate: "2026-09-03T00:00:00.000Z", StartDate: null, IsPublished: true }),
          ],
        })
      );

      const all = parse(await call({}));
      expect(all.map((i) => i.title)).toEqual(["A newest", "B middle", "A undated"]);

      const capped = parse(await call({ count: 2 }));
      expect(capped.map((i) => i.title)).toEqual(["A newest", "B middle"]);
    });
  });
});
