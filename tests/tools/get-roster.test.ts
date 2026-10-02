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

/**
 * A sign-in that has not finished is not an empty roster. CLAUDE.md forbids
 * turning a previously successful `{users: []}` response into an error, so
 * the tool keeps the success envelope and adds an explicit authPending/notice
 * pair a caller can check instead.
 */

import { AuthProcessError } from "../../src/auth/auth-runner.js";
import { ApiError } from "../../src/api/errors.js";

const mfaPending = () => new AuthProcessError("mfaPending", "MFA approval pending");

describe("get_roster while sign-in is pending", () => {
  it("reports authPending instead of an empty list read as success (includeStudents)", async () => {
    const { call } = setup(() => {
      throw mfaPending();
    });

    const result = await call({ courseId: COURSE_ID, includeStudents: true });

    expect(result.isError).toBeUndefined();
    const parsed = parse(result);
    expect(parsed).toMatchObject({ courseId: COURSE_ID, users: [], authPending: true });
    expect(parsed.notice).toContain("Approve the sign-in request");
  });

  it("reports authPending when only the TA route is rejected with 401, keeping the instructor that did answer", async () => {
    const { call } = setup((path) => {
      if (path.includes("roleId=135")) throw new ApiError(401, path, "expired");
      return { Objects: [user("prof")], Next: null };
    });

    const result = await call({ courseId: COURSE_ID });

    expect(result.isError).toBeUndefined();
    const parsed = parse(result);
    expect(parsed).toMatchObject({ courseId: COURSE_ID, authPending: true });
    expect(parsed.users.map((u: any) => u.name)).toEqual(["prof"]);
    expect(parsed.notice).toContain("Authentication expired");
  });

  it("still returns instructors when the TA route fails for a non-auth reason", async () => {
    const { call } = setup((path) => {
      if (path.includes("roleId=135")) {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      }
      return { Objects: [user("prof")], Next: null };
    });

    const result = await call({ courseId: COURSE_ID });

    expect(result.isError).toBeUndefined();
    const parsed = parse(result);
    expect(parsed.authPending).toBeUndefined();
    expect(parsed.users.map((u: any) => u.name)).toEqual(["prof"]);
  });
});

/**
 * The default staff view (includeStudents=false) found instructors and TAs by
 * Purdue's own role IDs (109/135). On any other tenant those IDs mean nothing
 * or belong to different roles, so the fast path quietly returned an empty
 * staff list. The role-ID path is still tried first — it stays exact and
 * cheap when it works — but when it comes back with zero users, one extra
 * unfiltered classlist fetch is made and matched against
 * ClasslistRoleDisplayName instead.
 */
describe("get_roster role name fallback", () => {
  const staffUser = (name: string, roleId: number, role: string) => ({
    ...user(name),
    RoleId: roleId,
    ClasslistRoleDisplayName: role,
  });

  it("still uses the role-ID fast path when it returns rows", async () => {
    const { call, requested } = setup((path) => {
      if (path.includes("roleId=109")) {
        return { Objects: [staffUser("prof", 109, "Instructor")], Next: null };
      }
      if (path.includes("roleId=135")) {
        return { Objects: [staffUser("ta", 135, "Teaching Assistant")], Next: null };
      }
      throw new Error(`unexpected unfiltered fetch: ${path}`);
    });

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.users.map((r: { name: string }) => r.name)).toEqual(["prof", "ta"]);
    expect(payload.roleFilter).toBeUndefined();
    expect(requested).toHaveLength(2);
    expect(requested.every((p) => p.includes("roleId="))).toBe(true);
  });

  it("falls back to role display names when the role-ID path returns nothing, excluding students", async () => {
    const { call, requested } = setup((path) => {
      if (path.includes("roleId=")) return { Objects: [], Next: null };
      return {
        Objects: [
          staffUser("prof", 501, "Instructor"),
          staffUser("assistant", 502, "Teaching Assistant"),
          staffUser("learner", 110, "Student"),
        ],
        Next: null,
      };
    });

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.users.map((r: { name: string }) => r.name)).toEqual(["prof", "assistant"]);
    expect(payload.roleFilter).toMatch(/display name/i);
    expect(requested.some((p) => !p.includes("roleId="))).toBe(true);
  });

  it("excludes a user with a null role display name from the fallback", async () => {
    const { call } = setup((path) => {
      if (path.includes("roleId=")) return { Objects: [], Next: null };
      return {
        Objects: [
          staffUser("prof", 501, "Instructor"),
          { ...user("mystery"), ClasslistRoleDisplayName: null },
        ],
        Next: null,
      };
    });

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.users.map((r: { name: string }) => r.name)).toEqual(["prof"]);
  });

  it("reports a classlist error instead of returning an empty staff list", async () => {
    const { call } = setup(() => {
      throw new Error("classlist unavailable");
    });

    const response = await call({ courseId: COURSE_ID });

    expect(response.isError).toBe(true);
  });

  it("matches Course Coordinator and Grader via the fallback", async () => {
    const { call } = setup((path) => {
      if (path.includes("roleId=")) return { Objects: [], Next: null };
      return {
        Objects: [
          staffUser("coord", 601, "Course Coordinator"),
          staffUser("grader", 602, "Grader"),
          staffUser("learner", 110, "Student"),
        ],
        Next: null,
      };
    });

    const payload = parse(await call({ courseId: COURSE_ID }));

    expect(payload.users.map((r: { name: string }) => r.name)).toEqual(["coord", "grader"]);
  });
});
