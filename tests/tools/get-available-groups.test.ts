import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGetAvailableGroups } from "../../src/tools/get-available-groups.js";
import { ApiError } from "../../src/api/errors.js";
import type { AppConfig } from "../../src/types/index.js";

const MY_ID = 42;
const COURSE = { Id: 202, Name: "HCI", Code: "hci" };
const OTHER = { Id: 303, Name: "Symbolic AI", Code: "sai" };
const OLD = { Id: 404, Name: "Security (two years ago)", Code: "sec" };
const UNDATED = { Id: 505, Name: "Faculty community", Code: "fac" };
const START_DATES: Record<number, string | null> = {
  [COURSE.Id]: "2026-08-14T00:00:00.000Z",
  [OTHER.Id]: "2026-08-14T00:00:00.000Z",
  [OLD.Id]: "2024-01-14T00:00:00.000Z",
  [UNDATED.Id]: null,
};
const NOW = new Date("2026-11-03T12:00:00Z");

const LP = "/d2l/api/lp/1.50";
const categoriesPath = (courseId: number) => `${LP}/${courseId}/groupcategories/`;
const groupsPath = (courseId: number, categoryId: number) => `${LP}/${courseId}/groupcategories/${categoryId}/groups/`;

const config = {
  baseUrl: "https://brightspace.example.edu",
  sessionDir: "/tmp/nope",
  tokenTtl: 3600,
  headless: true,
  courseFilter: { activeOnly: true },
} as AppConfig;

const category = (id: number, overrides: Record<string, unknown> = {}) => ({
  GroupCategoryId: id,
  Name: `Category ${id}`,
  Description: { Text: "", Html: "" },
  EnrollmentStyle: 3,
  MaxUsersPerGroup: 2,
  DescriptionsVisibleToEnrolees: true,
  SelfEnrollmentStartDate: null,
  SelfEnrollmentExpiryDate: null,
  ...overrides,
});
const group = (id: number, enrollments: number[], overrides: Record<string, unknown> = {}) => ({
  GroupId: id,
  Name: `Group ${id}`,
  Description: { Text: "", Html: "" },
  Enrollments: enrollments,
  ...overrides,
});

type Answer = unknown | Error;

function setup(routes: Record<string, Answer>) {
  const requested: string[] = [];
  const apiClient = {
    lp: (p: string) => `${LP}${p}`,
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.90/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      if (path === `${LP}/users/whoami`) return { Identifier: String(MY_ID) };
      if (path.includes("/enrollments/myenrollments/")) {
        return {
          // Like a school that never closes courses: no end dates, everything active.
          Items: [COURSE, OTHER, OLD, UNDATED].map((c) => ({
            OrgUnit: c,
            Access: { IsActive: true, StartDate: START_DATES[c.Id], EndDate: null },
          })),
          PagingInfo: { HasMoreItems: false, Bookmark: "" },
        };
      }
      if (!(path in routes)) throw new Error(`Unexpected path requested: ${path}`);
      const answer = routes[path];
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };
  registerGetAvailableGroups(server as any, apiClient as any, config);
  return { call: (args: unknown) => handler!(args), requested };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe("get_available_groups", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("lists groups with room in an open self-enrollment category, with spots left", async () => {
    const { call } = setup({
      [categoriesPath(COURSE.Id)]: [category(1, { Name: "Team Project", SelfEnrollmentExpiryDate: "2026-11-13T22:59:00.000Z" })],
      [groupsPath(COURSE.Id, 1)]: [group(10, []), group(11, [7]), group(12, [7, 8])],
    });

    const payload = parse(await call({ courseId: COURSE.Id }));

    expect(payload.coursesChecked).toBe(1);
    expect(payload.courses).toEqual([{
      courseId: COURSE.Id,
      courseName: "HCI",
      categories: [{
        categoryId: 1,
        name: "Team Project",
        signUpCloses: "2026-11-13T22:59:00.000Z",
        maxPerGroup: 2,
        groups: [
          { groupId: 10, name: "Group 10", members: 0, spotsLeft: 2 },
          { groupId: 11, name: "Group 11", members: 1, spotsLeft: 1 },
        ],
      }],
      alreadyInGroup: [],
    }]);
  });

  it("names the group instead of listing others when the user already has one in the category", async () => {
    const { call } = setup({
      [categoriesPath(COURSE.Id)]: [category(1, { Name: "Project Teams" })],
      [groupsPath(COURSE.Id, 1)]: [group(10, [MY_ID]), group(11, [])],
    });

    const payload = parse(await call({ courseId: COURSE.Id }));

    expect(payload.courses[0].categories).toEqual([]);
    expect(payload.courses[0].alreadyInGroup).toEqual([{ categoryId: 1, name: "Project Teams", groupName: "Group 10" }]);
  });

  it("skips categories that aren't self-enrollment or whose sign-up window is closed or not yet open", async () => {
    const { call, requested } = setup({
      [categoriesPath(COURSE.Id)]: [
        category(1, { EnrollmentStyle: 1 }),
        category(2, { SelfEnrollmentExpiryDate: "2026-10-12T15:00:00.000Z" }),
        category(3, { SelfEnrollmentStartDate: "2026-12-01T08:00:00.000Z" }),
      ],
    });

    const payload = parse(await call({ courseId: COURSE.Id }));

    expect(payload.courses).toEqual([]);
    expect(payload.note).toMatch(/No group sign-ups are open/);
    expect(requested.some((p) => p.includes("/groups/"))).toBe(false);
  });

  it("treats a category without a size limit as always having room", async () => {
    const { call } = setup({
      [categoriesPath(COURSE.Id)]: [category(1, { EnrollmentStyle: 4, MaxUsersPerGroup: null })],
      [groupsPath(COURSE.Id, 1)]: [group(10, [7, 8, 9])],
    });

    const payload = parse(await call({ courseId: COURSE.Id }));

    expect(payload.courses[0].categories[0].groups).toEqual([{ groupId: 10, name: "Group 10", members: 3, spotsLeft: null }]);
    expect(payload.courses[0].categories[0].maxPerGroup).toBeNull();
  });

  it("includes descriptions only when the category shows them to students", async () => {
    const described = { Text: "Thursday lab", Html: "<p>Thursday lab</p>" };
    const { call } = setup({
      [categoriesPath(COURSE.Id)]: [
        category(1, { Description: { Text: "Pick a slot", Html: "" } }),
        category(2, { DescriptionsVisibleToEnrolees: false }),
      ],
      [groupsPath(COURSE.Id, 1)]: [group(10, [], { Description: described })],
      [groupsPath(COURSE.Id, 2)]: [group(20, [], { Description: described })],
    });

    const [first, second] = parse(await call({ courseId: COURSE.Id })).courses[0].categories;

    expect(first.description).toBe("Pick a slot");
    expect(first.groups[0].description).toBe("Thursday lab");
    expect(second.groups[0]).not.toHaveProperty("description");
  });

  it("checks every enrolled course when no courseId is given and leaves out courses with nothing open", async () => {
    const { call } = setup({
      [categoriesPath(COURSE.Id)]: [category(1)],
      [groupsPath(COURSE.Id, 1)]: [group(10, [])],
      [categoriesPath(OTHER.Id)]: new ApiError(404, categoriesPath(OTHER.Id), "Not Found"),
    });

    const payload = parse(await call({}));

    expect(payload.coursesChecked).toBe(2);
    expect(payload.courses.map((c: any) => c.courseId)).toEqual([COURSE.Id]);
  });

  it("names an open category whose groups it couldn't read", async () => {
    const { call } = setup({
      [categoriesPath(COURSE.Id)]: [category(1, { Name: "Lab slots" })],
      [groupsPath(COURSE.Id, 1)]: new ApiError(403, groupsPath(COURSE.Id, 1), "Forbidden"),
    });

    const payload = parse(await call({ courseId: COURSE.Id }));

    expect(payload.courses[0].unreadCategories).toEqual(["Lab slots"]);
  });

  it("keeps the other courses and names the one that failed", async () => {
    const { call } = setup({
      [categoriesPath(COURSE.Id)]: [category(1)],
      [groupsPath(COURSE.Id, 1)]: [group(10, [])],
      [categoriesPath(OTHER.Id)]: new ApiError(500, categoriesPath(OTHER.Id), "Server Error"),
    });

    const payload = parse(await call({}));

    expect(payload.courses.map((c: any) => c.courseId)).toEqual([COURSE.Id]);
    expect(payload.note).toMatch(new RegExp(`course\\(s\\) ${OTHER.Id}`));
  });

  it("skips courses that started over a year ago or have no start date, and says how many", async () => {
    const { call, requested } = setup({
      [categoriesPath(COURSE.Id)]: [category(1)],
      [groupsPath(COURSE.Id, 1)]: [group(10, [])],
      [categoriesPath(OTHER.Id)]: [],
    });

    const payload = parse(await call({}));

    expect(payload.coursesChecked).toBe(2);
    expect(requested).not.toContain(categoriesPath(OLD.Id));
    expect(requested).not.toContain(categoriesPath(UNDATED.Id));
    expect(payload.note).toMatch(/includeOlder: true to also check the other 2/);
  });

  it("checks older and undated courses too with includeOlder", async () => {
    const { call } = setup({
      [categoriesPath(COURSE.Id)]: [],
      [categoriesPath(OTHER.Id)]: [],
      [categoriesPath(OLD.Id)]: [category(1, { Name: "Old sign-up" })],
      [groupsPath(OLD.Id, 1)]: [group(10, [])],
      [categoriesPath(UNDATED.Id)]: [],
    });

    const payload = parse(await call({ includeOlder: true }));

    expect(payload.coursesChecked).toBe(4);
    expect(payload.courses.map((c: any) => c.courseId)).toEqual([OLD.Id]);
    expect(payload.note).toBeUndefined();
  });

  it("checks a named course whatever its start date", async () => {
    const { call } = setup({
      [categoriesPath(OLD.Id)]: [category(1)],
      [groupsPath(OLD.Id, 1)]: [group(10, [])],
    });

    const payload = parse(await call({ courseId: OLD.Id }));

    expect(payload.courses.map((c: any) => c.courseId)).toEqual([OLD.Id]);
  });
});
