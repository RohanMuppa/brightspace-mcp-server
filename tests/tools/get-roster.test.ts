import { describe, it, expect, vi } from "vitest";
import { registerGetRoster } from "../../src/tools/get-roster.js";

/**
 * The roster reads the same paged classlist endpoint, so it dropped users past
 * the first page too. A full class can easily outrun one page.
 *
 * It also capped the result at 100 users and said so only in a log line the
 * model never sees, so a 340 person lecture looked like a 100 person one. The
 * cap is still there, because an enormous roster would swamp the response, but
 * it is now reported in the payload and the caller can raise it.
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

const parse = (result: any) => JSON.parse(result.content[0].text);

describe("get_roster pagination", () => {
  it("returns students across both pages", async () => {
    const { call, requested } = setup((path) =>
      path.includes("bookmark=b1")
        ? { Objects: [user("grace")], Next: null }
        : { Objects: [user("ada")], Next: "b1" }
    );

    const payload = parse(await call({ courseId: COURSE_ID, includeStudents: true }));

    expect(payload.users.map((r: { name: string }) => r.name)).toEqual(["ada", "grace"]);
    expect(requested).toHaveLength(2);
  });
});

describe("get_roster truncation", () => {
  const manyUsers = (count: number) =>
    Array.from({ length: count }, (_, i) => user(`student${i}`));

  it("reports the total and the truncation rather than hiding it", async () => {
    const { call } = setup(() => ({ Objects: manyUsers(340), Next: null }));

    const payload = parse(await call({ courseId: COURSE_ID, includeStudents: true }));

    expect(payload.total).toBe(340);
    expect(payload.returned).toBe(100);
    expect(payload.truncated).toBe(true);
    expect(payload.users).toHaveLength(100);
    expect(payload.note).toMatch(/limit/i);
  });

  it("is not truncated when the class fits", async () => {
    const { call } = setup(() => ({ Objects: manyUsers(12), Next: null }));

    const payload = parse(await call({ courseId: COURSE_ID, includeStudents: true }));

    expect(payload.total).toBe(12);
    expect(payload.returned).toBe(12);
    expect(payload.truncated).toBe(false);
    expect(payload.note).toBeUndefined();
  });

  it("honors an explicit limit", async () => {
    const { call } = setup(() => ({ Objects: manyUsers(340), Next: null }));

    const payload = parse(
      await call({ courseId: COURSE_ID, includeStudents: true, limit: 250 })
    );

    expect(payload.returned).toBe(250);
    expect(payload.truncated).toBe(true);
  });
});
