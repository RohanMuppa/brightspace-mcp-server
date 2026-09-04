import { describe, it, expect, vi } from "vitest";
import { registerGetRoster } from "../../src/tools/get-roster.js";

/**
 * The roster reads the same paged classlist endpoint, so it dropped users past
 * the first page too. A full class can easily outrun one page.
 */

const COURSE_ID = 101;

const user = (name: string) => ({
  Identifier: name.length,
  DisplayName: name,
  Email: `${name}@example.edu`,
  FirstName: name,
  LastName: null,
  RoleId: null,
  ClasslistRoleDisplayName: "Student",
  IsOnline: false,
  LastAccessed: null,
});

function setup(respond: (path: string) => unknown) {
  const requested: string[] = [];
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return respond(path);
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetRoster(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), requested };
}

describe("get_roster pagination", () => {
  it("returns students across both pages", async () => {
    const { call, requested } = setup((path) =>
      path.includes("bookmark=b1")
        ? { Objects: [user("grace")], Next: null }
        : { Objects: [user("ada")], Next: "b1" }
    );

    const result = await call({ courseId: COURSE_ID, includeStudents: true });
    const roster = JSON.parse(result.content[0].text);

    expect(roster.map((r: { name: string }) => r.name)).toEqual(["ada", "grace"]);
    expect(requested).toHaveLength(2);
  });
});
