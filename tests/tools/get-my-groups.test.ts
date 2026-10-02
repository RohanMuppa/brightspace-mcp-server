import { describe, it, expect, vi } from "vitest";
import { registerGetMyGroups } from "../../src/tools/get-my-groups.js";
import { ApiError } from "../../src/api/errors.js";

const COURSE_ID = 202;
const MY_ID = 42;

const LP_PREFIX = "/d2l/api/lp/1.50";
const LE_PREFIX = "/d2l/api/le/1.90";

const WHOAMI_PATH = `${LP_PREFIX}/users/whoami`;
const CATEGORIES_PATH = `${LP_PREFIX}/${COURSE_ID}/groupcategories/`;
const CLASSLIST_PATH = `${LE_PREFIX}/${COURSE_ID}/classlist/paged/`;
const groupsPath = (categoryId: number) =>
  `${LP_PREFIX}/${COURSE_ID}/groupcategories/${categoryId}/groups/`;

const classlistUser = (id: number | string, name: string) => ({
  Identifier: id,
  DisplayName: name,
  Email: `${name}@example.edu`,
  FirstName: name,
  LastName: null,
  RoleId: null,
  ClasslistRoleDisplayName: "Student",
  IsOnline: false,
  LastAccessed: null,
});

interface Routes {
  categories?: unknown;
  categoriesError?: Error;
  groups?: Record<number, unknown>;
  groupsError?: Record<number, Error>;
  classlist?: unknown;
  classlistError?: Error;
}

function setup(routes: Routes) {
  const requested: string[] = [];
  const apiClient = {
    lp: (p: string) => `${LP_PREFIX}${p}`,
    le: (orgUnitId: number, p: string) => `${LE_PREFIX}/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);

      if (path === WHOAMI_PATH) return { Identifier: MY_ID, DisplayName: "Me" };

      if (path === CATEGORIES_PATH) {
        if (routes.categoriesError) throw routes.categoriesError;
        return routes.categories ?? [];
      }

      if (path === CLASSLIST_PATH) {
        if (routes.classlistError) throw routes.classlistError;
        return routes.classlist ?? { Objects: [], Next: null };
      }

      for (const [categoryId, groups] of Object.entries(routes.groups ?? {})) {
        if (path === groupsPath(Number(categoryId))) return groups;
      }
      for (const [categoryId, error] of Object.entries(routes.groupsError ?? {})) {
        if (path === groupsPath(Number(categoryId))) throw error;
      }

      throw new Error(`Unexpected path requested: ${path}`);
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetMyGroups(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), requested };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe("get_my_groups happy path", () => {
  it("returns only the groups the current user belongs to, across categories", async () => {
    const { call } = setup({
      categories: [
        { GroupCategoryId: 1, Name: "Project Groups" },
        { GroupCategoryId: 2, Name: "Lab Sections" },
      ],
      groups: {
        1: [
          { GroupId: 10, Name: "Group A", Code: "GA", Enrollments: [MY_ID, 7] },
          { GroupId: 11, Name: "Group B", Code: "GB", Enrollments: [8, 9] },
        ],
        2: [{ GroupId: 20, Name: "Lab 1", Enrollments: [MY_ID] }],
      },
      classlist: {
        Objects: [classlistUser(MY_ID, "Ada Lovelace"), classlistUser(7, "Grace Hopper")],
        Next: null,
      },
    });

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.courseId).toBe(COURSE_ID);
    expect(payload.note).toBeUndefined();
    expect(payload.groups).toHaveLength(2);

    const [groupA, lab1] = payload.groups;
    expect(groupA).toEqual({
      categoryId: 1,
      categoryName: "Project Groups",
      groupId: 10,
      groupName: "Group A",
      groupCode: "GA",
      members: [
        { userId: MY_ID, name: "Ada Lovelace" },
        { userId: 7, name: "Grace Hopper" },
      ],
    });
    expect(lab1.groupCode).toBeUndefined();
    expect(lab1.members).toEqual([{ userId: MY_ID, name: "Ada Lovelace" }]);

    // "Group B" never contained the current user and must not appear.
    expect(payload.groups.some((g: any) => g.groupId === 11)).toBe(false);
  });

  it("resolves member names when D2L returns Identifier as a string", async () => {
    const { call } = setup({
      categories: [{ GroupCategoryId: 1, Name: "Project Groups" }],
      groups: { 1: [{ GroupId: 10, Name: "Group A", Enrollments: [MY_ID, 7] }] },
      classlist: {
        // Real tenants send Identifier as a numeric-looking string, not a number.
        Objects: [classlistUser(String(MY_ID), "Ada Lovelace"), classlistUser(String(7), "Grace Hopper")],
        Next: null,
      },
    });

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.groups[0].members).toEqual([
      { userId: MY_ID, name: "Ada Lovelace" },
      { userId: 7, name: "Grace Hopper" },
    ]);
  });
});

describe("get_my_groups classlist access", () => {
  it("returns member ids with null names when the classlist is forbidden", async () => {
    const { call } = setup({
      categories: [{ GroupCategoryId: 1, Name: "Project Groups" }],
      groups: { 1: [{ GroupId: 10, Name: "Group A", Enrollments: [MY_ID, 7] }] },
      classlistError: new ApiError(403, CLASSLIST_PATH, "Forbidden"),
    });

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0].members).toEqual([
      { userId: MY_ID, name: null },
      { userId: 7, name: null },
    ]);
  });
});

describe("get_my_groups missing group data", () => {
  it("returns an empty list with a note when group categories 404", async () => {
    const { call, requested } = setup({
      categoriesError: new ApiError(404, CATEGORIES_PATH, "Not Found"),
    });

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.courseId).toBe(COURSE_ID);
    expect(payload.groups).toEqual([]);
    expect(payload.note).toMatch(/no groups/i);
    // Never falls through to the classlist once categories are known absent.
    expect(requested).not.toContain(CLASSLIST_PATH);
  });

  it("returns an empty list with a note when group categories are forbidden", async () => {
    const { call } = setup({
      categoriesError: new ApiError(403, CATEGORIES_PATH, "Forbidden"),
    });

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.groups).toEqual([]);
    expect(payload.note).toMatch(/no groups/i);
  });
});

describe("get_my_groups user in no group", () => {
  it("notes the user isn't a member of any group, distinct from no groups being visible, and never fetches the classlist", async () => {
    const { call, requested } = setup({
      categories: [{ GroupCategoryId: 1, Name: "Project Groups" }],
      groups: { 1: [{ GroupId: 10, Name: "Group A", Enrollments: [7, 8] }] },
    });

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.courseId).toBe(COURSE_ID);
    expect(payload.groups).toEqual([]);
    expect(payload.note).toMatch(/not a member/i);
    expect(payload.note).not.toMatch(/no groups are visible/i);
    // No match was found, so the classlist (needed only for member names)
    // must never be fetched.
    expect(requested).not.toContain(CLASSLIST_PATH);
  });
});

describe("get_my_groups schema validation", () => {
  it("rejects a missing courseId", async () => {
    const { call, requested } = setup({});

    const result = await call({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/courseId/);
    expect(requested).toEqual([]);
  });
});
