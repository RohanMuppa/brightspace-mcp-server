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

function makeConfig(activeOnly: boolean): AppConfig {
  return {
    baseUrl: "https://brightspace.example.edu",
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly },
  } as AppConfig;
}

/** Captures the registered handler and the paths it requests. */
function setup(config: AppConfig) {
  const requested: string[] = [];
  const apiClient = {
    lp: (p: string) => `/d2l/api/lp/1.0${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      const activeOnlyQuery = path.includes("isActive=true");
      const items = COURSES.filter((c) => !activeOnlyQuery || c.isActive);
      return {
        Items: items.map((c) => ({
          OrgUnit: { Id: c.id, Name: c.name, Code: c.code },
          Access: {
            ClasslistRoleName: "Instructor",
            IsActive: c.isActive,
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
