import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerGetMyCourses } from "../../src/tools/get-my-courses.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Regression tests for how get_my_courses resolves activeOnly.
 *
 * The tool argument shapes the myenrollments query string, but the fetched rows
 * are then run through applyCourseFilter. If that filter keeps using the global
 * config value, passing activeOnly:false fetches inactive courses and throws them
 * away again — the argument silently does nothing.
 */

const COURSES = [
  { id: 15853, name: "Sandbox", code: "sandbox", isActive: true },
  { id: 319544, name: "IDSN-532", code: "20263_34066", isActive: false },
];

type Dated = { id: number; name: string; code: string; isActive: boolean; startDate?: string | null; endDate?: string | null };

function makeConfig(activeOnly: boolean, currentOnly = false): AppConfig {
  return {
    baseUrl: "https://brightspace.example.edu",
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly, currentOnly },
  } as AppConfig;
}

/** Captures the registered handler and the paths it requests. */
function setup(config: AppConfig, courses: Dated[] = COURSES) {
  const requested: string[] = [];
  const apiClient = {
    lp: (p: string) => `/d2l/api/lp/1.0${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      const activeOnlyQuery = path.includes("isActive=true");
      const items = courses.filter((c) => !activeOnlyQuery || c.isActive);
      return {
        Items: items.map((c) => ({
          OrgUnit: { Id: c.id, Name: c.name, Code: c.code },
          Access: {
            ClasslistRoleName: "Instructor",
            IsActive: c.isActive,
            StartDate: c.startDate ?? null,
            EndDate: c.endDate ?? null,
            LastAccessed: null,
          },
        })),
      };
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_name: string, _meta: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetMyCourses(server as any, apiClient as any, config);
  return { call: (args: unknown) => handler!(args), requested };
}

const idsOf = (result: any): number[] =>
  JSON.parse(result.content[0].text).map((c: { id: number }) => c.id);

describe("get_my_courses activeOnly resolution", () => {
  let config: AppConfig;

  beforeEach(() => {
    config = makeConfig(true);
  });

  it("returns inactive courses when the caller passes activeOnly:false", async () => {
    const { call, requested } = setup(config);

    const result = await call({ activeOnly: false });

    expect(requested[0]).not.toContain("isActive=true");
    expect(idsOf(result)).toEqual([15853, 319544]);
  });

  it("filters to active courses when the caller passes activeOnly:true", async () => {
    const { call, requested } = setup(config);

    const result = await call({ activeOnly: true });

    expect(requested[0]).toContain("isActive=true");
    expect(idsOf(result)).toEqual([15853]);
  });

  it("falls back to the configured policy when the argument is omitted", async () => {
    const { call } = setup(makeConfig(false));

    const result = await call({});

    expect(idsOf(result)).toEqual([15853, 319544]);
  });

  it("honours a configured activeOnly:true when the argument is omitted", async () => {
    const { call } = setup(makeConfig(true));

    const result = await call({});

    expect(idsOf(result)).toEqual([15853]);
  });
});

/**
 * Enrollments arrive one page at a time. Reading only the first page used to
 * drop every course after it and log a warning in place of the data.
 */
describe("get_my_courses pagination", () => {
  it("returns courses from every page of enrollments", async () => {
    const requested: string[] = [];
    const page = (id: number, bookmark?: string) => ({
      Items: [
        {
          OrgUnit: { Id: id, Name: `Course ${id}`, Code: `c${id}` },
          Access: { ClasslistRoleName: "Student", IsActive: true, LastAccessed: null },
        },
      ],
      PagingInfo: { HasMoreItems: bookmark !== undefined, Bookmark: bookmark ?? "" },
    });

    const apiClient = {
      lp: (p: string) => `/d2l/api/lp/1.0${p}`,
      get: vi.fn(async (path: string) => {
        requested.push(path);
        return path.includes("bookmark=b1") ? page(2) : page(1, "b1");
      }),
    };

    let handler: (args: unknown) => Promise<any>;
    const server = {
      registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
        handler = fn;
      },
    };
    registerGetMyCourses(server as any, apiClient as any, makeConfig(true));

    const result = await handler!({});

    expect(idsOf(result)).toEqual([1, 2]);
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain("bookmark=b1");
  });
});

/**
 * currentOnly (D2L_CURRENT_ONLY) is opt-in and defaults to false. A course
 * whose enrollment window has already ended must disappear from the result
 * only when currentOnly is explicitly turned on -- never by default.
 */
describe("get_my_courses currentOnly filter", () => {
  // Computed relative to the real clock (the tool calls applyCourseFilter with
  // its default `now`) so this stays correct regardless of when it runs.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const DATED_COURSES: Dated[] = [
    {
      id: 1,
      name: "Current Semester",
      code: "current",
      isActive: true,
      startDate: new Date(now - 30 * DAY_MS).toISOString(),
      endDate: new Date(now + 60 * DAY_MS).toISOString(),
    },
    {
      id: 2,
      name: "Past Semester",
      code: "past",
      isActive: true,
      startDate: new Date(now - 2 * 365 * DAY_MS).toISOString(),
      endDate: new Date(now - 365 * DAY_MS).toISOString(),
    },
  ];

  it("keeps the dated-out course when currentOnly is off (the default)", async () => {
    const { call } = setup(makeConfig(false, false), DATED_COURSES);

    const result = await call({});

    expect(idsOf(result).sort()).toEqual([1, 2]);
  });

  it("drops the dated-out course only when currentOnly is on", async () => {
    const { call } = setup(makeConfig(false, true), DATED_COURSES);

    const result = await call({});

    expect(idsOf(result)).toEqual([1]);
  });
});

/**
 * The agent never sees the server's course settings, so a course they hide
 * must not read as one the student is not enrolled in (#484).
 */
describe("get_my_courses notice for courses hidden by settings", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const DATED: Dated[] = [
    {
      id: 1, name: "Current", code: "cur", isActive: true,
      startDate: new Date(now - 30 * DAY_MS).toISOString(),
      endDate: new Date(now + 60 * DAY_MS).toISOString(),
    },
    {
      id: 2, name: "Past", code: "past", isActive: true,
      startDate: new Date(now - 400 * DAY_MS).toISOString(),
      endDate: new Date(now - 300 * DAY_MS).toISOString(),
    },
    { id: 3, name: "Inactive", code: "off", isActive: false },
  ];

  function configWith(filter: Partial<AppConfig["courseFilter"]>): AppConfig {
    const config = makeConfig(true);
    config.courseFilter = { ...config.courseFilter, ...filter };
    return config;
  }

  it("names the courses D2L_CURRENT_ONLY hid, keeping the bare array first", async () => {
    const { call } = setup(configWith({ currentOnly: true }), DATED);

    const result = await call({});

    expect(idsOf(result)).toEqual([1]);
    expect(result.content).toHaveLength(2);
    const notice = result.content[1].text;
    expect(notice).toContain("1 enrolled course is hidden");
    expect(notice).toContain("D2L_CURRENT_ONLY");
    expect(notice).toContain(": 2.");
    expect(notice).toContain("courseId");
  });

  it("names D2L_EXCLUDE_COURSES and D2L_INCLUDE_COURSES when they hide courses", async () => {
    const excluded = await setup(configWith({ excludeCourseIds: [1] }), DATED).call({});
    expect(idsOf(excluded)).toEqual([2]);
    expect(excluded.content[1].text).toContain("D2L_EXCLUDE_COURSES");
    expect(excluded.content[1].text).toContain(": 1.");

    const included = await setup(configWith({ includeCourseIds: [2] }), DATED).call({});
    expect(idsOf(included)).toEqual([2]);
    expect(included.content[1].text).toContain("D2L_INCLUDE_COURSES");
  });

  it("does not count a course that activeOnly removed", async () => {
    const { call } = setup(configWith({ excludeCourseIds: [2] }), DATED);

    const result = await call({ activeOnly: false });

    expect(idsOf(result)).toEqual([1, 3]);
    expect(result.content[1].text).toContain("1 enrolled course is hidden");
    expect(result.content[1].text).toContain("not listed: 2.");

    const activeOnly = await setup(configWith({ currentOnly: false }), DATED).call({});
    expect(idsOf(activeOnly)).toEqual([1, 2]);
    expect(activeOnly.content).toHaveLength(1);
  });

  it("adds no notice when a setting is on but hides nothing", async () => {
    const { call } = setup(configWith({ excludeCourseIds: [999] }), DATED);

    const result = await call({});

    expect(idsOf(result)).toEqual([1, 2]);
    expect(result.content).toHaveLength(1);
  });
});
