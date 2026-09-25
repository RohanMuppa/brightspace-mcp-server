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

const enrollmentItem = (c: typeof COURSE_A, isActive = true) => ({
  OrgUnit: c,
  Access: { ClasslistRoleName: "Student", IsActive: isActive, LastAccessed: null },
});

const enrollments = (...courses: Array<typeof COURSE_A>) => ({
  Items: courses.map((c) => enrollmentItem(c)),
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

  it("omits createdDate and startDate, keeping only the effective date", async () => {
    const { call } = setup(
      oneCourse([
        news({ Id: 1, Title: "Posted", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-02T00:00:00.000Z", IsPublished: true }),
      ])
    );

    const items = parse(await call({ courseId: COURSE_A.Id }));
    expect(items[0]).not.toHaveProperty("createdDate");
    expect(items[0]).not.toHaveProperty("startDate");
    expect(items[0].date).toBe("2026-09-02T00:00:00.000Z");
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

    /**
     * myenrollments is bookmark-paged. Reading only the first page hides every
     * course past it — on a real Purdue account 44 enrollments come back over
     * several pages, so the later courses' announcements simply vanished.
     */
    it("follows the enrollment bookmark chain instead of stopping at page one", async () => {
      const newsByCourse: Record<number, unknown[]> = {
        [COURSE_A.Id]: [
          news({ Id: 1, Title: "A post", CreatedDate: "2026-09-08T00:00:00.000Z", StartDate: null, IsPublished: true }),
        ],
        [COURSE_B.Id]: [
          news({ Id: 2, Title: "B post", CreatedDate: "2026-09-03T00:00:00.000Z", StartDate: null, IsPublished: true }),
        ],
      };

      const { call, requested } = setup((path) => {
        if (path.includes("/enrollments/")) {
          return path.includes("bookmark=")
            ? { Items: [enrollmentItem(COURSE_B)], PagingInfo: { HasMoreItems: false } }
            : {
                Items: [enrollmentItem(COURSE_A)],
                PagingInfo: { HasMoreItems: true, Bookmark: "page-2" },
              };
        }
        const match = path.match(/\/le\/1\.0\/(\d+)\//);
        return match ? newsByCourse[Number(match[1])] ?? [] : [];
      });

      const items = parse(await call({}));
      expect(items.map((i) => i.title)).toEqual(["A post", "B post"]);
      expect(requested.filter((p) => p.includes("/enrollments/"))).toHaveLength(2);
    });

    /**
     * activeOnly is a configured policy, not a constant. With it off the user
     * asked to see past courses; hard-coding isActive=true into the query made
     * the server drop them before the filter ever saw them.
     */
    it("drops isActive=true from the query when activeOnly is off", async () => {
      const respond: Responder = (path) => {
        if (path.includes("/enrollments/")) {
          // D2L filters server-side, so isActive=true really does hide COURSE_B.
          const items = path.includes("isActive=true")
            ? [enrollmentItem(COURSE_A)]
            : [enrollmentItem(COURSE_A), enrollmentItem(COURSE_B, false)];
          return { Items: items };
        }
        const match = path.match(/\/le\/1\.0\/(\d+)\//);
        if (!match) return [];
        return [
          news({
            Id: Number(match[1]),
            Title: `post ${match[1]}`,
            CreatedDate: "2026-09-01T00:00:00.000Z",
            StartDate: null,
            IsPublished: true,
          }),
        ];
      };

      const { call, requested } = setup(respond, {
        ...makeConfig(),
        courseFilter: { activeOnly: false },
      } as AppConfig);

      const items = parse(await call({}));
      expect(requested[0]).not.toContain("isActive=true");
      expect(items.map((i) => i.courseId).sort()).toEqual([COURSE_A.Id, COURSE_B.Id]);
    });

    it("still asks only for active enrollments under the default policy", async () => {
      const { call, requested } = setup(manyCourses({ [COURSE_A.Id]: [] }));
      await call({});
      expect(requested[0]).toContain("isActive=true");
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

  describe("modifiedSince (#34)", () => {
    const CUTOFF = "2026-09-15T00:00:00.000Z";

    it("emits lastModified on every announcement", async () => {
      const { call } = setup(
        oneCourse([
          news({ Id: 1, Title: "A", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", LastModifiedDate: "2026-09-10T00:00:00.000Z", IsPublished: true }),
        ])
      );

      const items = parse(await call({ courseId: COURSE_A.Id }));
      expect(items[0].lastModified).toBe("2026-09-10T00:00:00.000Z");
    });

    it("returns a bare array, unchanged, when modifiedSince is omitted", async () => {
      const { call } = setup(
        oneCourse([
          news({ Id: 1, Title: "A", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", IsPublished: true }),
        ])
      );

      const result = await call({ courseId: COURSE_A.Id });
      const body = JSON.parse(result.content[0].text);
      expect(Array.isArray(body)).toBe(true);
    });

    it("filters out announcements modified before the cutoff, on the single-course path", async () => {
      const { call } = setup(
        oneCourse([
          news({ Id: 1, Title: "New", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", LastModifiedDate: "2026-09-20T00:00:00.000Z", IsPublished: true }),
          news({ Id: 2, Title: "Old", CreatedDate: "2026-09-02T00:00:00.000Z", StartDate: "2026-09-02T00:00:00.000Z", LastModifiedDate: "2026-01-01T00:00:00.000Z", IsPublished: true }),
        ])
      );

      const result = await call({ courseId: COURSE_A.Id, modifiedSince: CUTOFF });
      const body = JSON.parse(result.content[0].text);

      expect(body.announcements.map((a: any) => a.title)).toEqual(["New"]);
      expect(body.modifiedSince).toBe(CUTOFF);
      expect(body.returned).toBe(1);
      expect(body.filteredOut).toBe(1);
    });

    it("filters across courses on the all-courses path", async () => {
      const { call } = setup(
        manyCourses({
          [COURSE_A.Id]: [
            news({ Id: 1, Title: "A new", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", LastModifiedDate: "2026-09-20T00:00:00.000Z", IsPublished: true }),
          ],
          [COURSE_B.Id]: [
            news({ Id: 2, Title: "B old", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", LastModifiedDate: "2026-01-01T00:00:00.000Z", IsPublished: true }),
          ],
        })
      );

      const result = await call({ modifiedSince: CUTOFF });
      const body = JSON.parse(result.content[0].text);

      expect(body.announcements.map((a: any) => a.title)).toEqual(["A new"]);
      expect(body.filteredOut).toBe(1);
    });

    it("keeps an announcement with no LastModifiedDate rather than dropping it", async () => {
      const { call } = setup(
        oneCourse([
          news({ Id: 1, Title: "No timestamp", CreatedDate: "2026-09-01T00:00:00.000Z", StartDate: "2026-09-01T00:00:00.000Z", LastModifiedDate: null as any, IsPublished: true }),
        ])
      );

      const result = await call({ courseId: COURSE_A.Id, modifiedSince: CUTOFF });
      const body = JSON.parse(result.content[0].text);
      expect(body.announcements.map((a: any) => a.title)).toEqual(["No timestamp"]);
      expect(body.filteredOut).toBe(0);
    });

    it("rejects a malformed modifiedSince with a validation error naming the expected format", async () => {
      const { call } = setup(oneCourse([]));
      const result = await call({ courseId: COURSE_A.Id, modifiedSince: "yesterday" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/modifiedSince/);
      expect(result.content[0].text).toMatch(/ISO 8601/);
    });
  });
});

describe("get_announcements attachments", () => {
  it("lists an announcement's attached files by fileId, fileName and size", async () => {
    const { call } = setup(
      oneCourse([
        news({
          Id: 1,
          StartDate: "2026-09-18T00:00:00.000Z",
          Attachments: [{ FileId: 77, FileName: "Field notes prompts.docx", Size: 20480 }],
        }),
      ])
    );

    const items = parse(await call({ courseId: COURSE_A.Id }));
    expect(items[0].attachments).toEqual([
      { fileId: 77, fileName: "Field notes prompts.docx", size: 20480 },
    ]);
  });

  it("omits the attachments key on an announcement with no files", async () => {
    const { call } = setup(
      oneCourse([news({ Id: 1, StartDate: "2026-09-18T00:00:00.000Z", Attachments: [] })])
    );

    const items = parse(await call({ courseId: COURSE_A.Id }));
    expect(items[0]).not.toHaveProperty("attachments");
  });

  it("omits the attachments key when the tenant sends no Attachments field", async () => {
    const { call } = setup(
      oneCourse([news({ Id: 1, StartDate: "2026-09-18T00:00:00.000Z", Attachments: undefined })])
    );

    const items = parse(await call({ courseId: COURSE_A.Id }));
    expect(items[0]).not.toHaveProperty("attachments");
  });

  it("carries the courseId beside attachments on the all-courses path", async () => {
    const { call } = setup(
      manyCourses({
        [COURSE_A.Id]: [
          news({
            Id: 1,
            StartDate: "2026-09-18T00:00:00.000Z",
            Attachments: [{ FileId: 77, FileName: "rubric.pdf", Size: 100 }],
          }),
        ],
      })
    );

    const items = parse(await call({}));
    expect(items[0]).toMatchObject({
      courseId: COURSE_A.Id,
      attachments: [{ fileId: 77, fileName: "rubric.pdf", size: 100 }],
    });
  });
});
