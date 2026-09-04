import { describe, it, expect, vi } from "vitest";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";

/**
 * A module whose structure lists itself is a cycle, and with no maxDepth the
 * tree builder followed it forever. Descent now stops at a hard ceiling.
 */

const COURSE_ID = 101;

const SELF_REFERENCING_MODULE = {
  Id: 1,
  Title: "Week 1",
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

function setup() {
  const requested: string[] = [];
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      if (path.endsWith("/content/userprogress/")) return [];
      return [SELF_REFERENCING_MODULE];
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetCourseContent(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), requested };
}

describe("get_course_content recursion cap", () => {
  it("terminates on a self-referencing module structure", async () => {
    const { call, requested } = setup();

    const result = await call({ courseId: COURSE_ID });
    const body = JSON.parse(result.content[0].text);

    // Twelve levels of descent: the root module plus twelve nested copies.
    expect(body.moduleCount).toBe(13);
    expect(requested.filter((p) => p.includes("/structure/"))).toHaveLength(12);
  });

  it("still honours a smaller maxDepth", async () => {
    const { call, requested } = setup();

    const result = await call({ courseId: COURSE_ID, maxDepth: 2 });
    const body = JSON.parse(result.content[0].text);

    expect(body.moduleCount).toBe(3);
    expect(requested.filter((p) => p.includes("/structure/"))).toHaveLength(2);
  });
});
