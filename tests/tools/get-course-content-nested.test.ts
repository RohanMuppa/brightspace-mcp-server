import { describe, it, expect, vi } from "vitest";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";
import { ApiError } from "../../src/api/index.js";

/**
 * Live report, course 1632232, 2026-11-19: modifiedSince hid an early-uploaded
 * HW12 problems PDF next to a newer quiz link, and moduleTitle "HW12" found
 * nothing because the module is nested under "Homeworks".
 */

const COURSE_ID = 1632232;
const OLD = "2026-10-27T00:00:00.000Z";
const NEW = "2026-11-13T00:00:00.000Z";
const BETWEEN = "2026-11-01T00:00:00.000Z";

const base = {
  ShortTitle: null,
  Description: null,
  ModuleStartDate: null,
  ModuleEndDate: null,
  ModuleDueDate: null,
  IsHidden: false,
  IsLocked: false,
};
const mod = (id: number, title: string, lastModified: string | null = OLD) => ({
  ...base, Id: id, Title: title, Type: 0, LastModifiedDate: lastModified,
});
const topic = (id: number, title: string, topicType: number, lastModified: string | null) => ({
  ...base, Id: id, Title: title, Type: 1, TopicType: topicType, LastModifiedDate: lastModified,
});

function setup(structures: Record<number, unknown>, roots: unknown[]) {
  const requested: string[] = [];
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      if (path.endsWith("/content/userprogress/")) return [];
      if (path.endsWith("/content/root/")) return roots;
      const m = path.match(/\/content\/modules\/(\d+)\/structure\//);
      if (m) {
        const s = structures[Number(m[1])];
        if (s instanceof Error) throw s;
        return s ?? [];
      }
      return [];
    }),
  };
  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };
  registerGetCourseContent(server as any, apiClient as any);
  return {
    call: async (args: unknown) => JSON.parse((await handler!(args)).content[0].text),
    requested,
  };
}

const hw12Course = () =>
  setup(
    {
      1: [mod(2, "HW12", OLD), mod(3, "HW11", OLD)],
      2: [topic(10, "ECE2k2_HW12", 1, OLD), topic(11, "HW12", 2, NEW)],
      3: [topic(12, "HW11 pdf", 1, OLD)],
    },
    [mod(1, "Homeworks", OLD), mod(4, "Labs", OLD)]
  );

describe("get_course_content modifiedSince names what it hid", () => {
  it("lists the old file next to the new link in hiddenByFilter", async () => {
    const { call } = hw12Course();
    const body = await call({ courseId: COURSE_ID, modifiedSince: BETWEEN });

    const hw12 = body.contentTree[0].children.find((m: any) => m.id === 2);
    expect(hw12.children.map((t: any) => t.id)).toEqual([11]);
    expect(hw12.hiddenByFilter).toEqual([
      { id: 10, title: "ECE2k2_HW12", type: "file", lastModified: OLD },
    ]);
  });

  it("counts dropped child modules instead of listing them", async () => {
    const { call } = hw12Course();
    const body = await call({ courseId: COURSE_ID, modifiedSince: BETWEEN });

    expect(body.contentTree[0].hiddenModulesByFilter).toBe(1);
  });

  it("adds no hidden fields to a module that lost nothing", async () => {
    const { call } = setup({ 1: [topic(1, "a", 1, NEW)] }, [mod(1, "M", OLD)]);
    const body = await call({ courseId: COURSE_ID, modifiedSince: BETWEEN });

    expect(body.contentTree[0]).not.toHaveProperty("hiddenByFilter");
    expect(body.contentTree[0]).not.toHaveProperty("hiddenModulesByFilter");
    expect(body).not.toHaveProperty("notice");
  });

  it("adds a notice saying lastModified is not visibility when something was filtered out", async () => {
    const { call } = hw12Course();
    const body = await call({ courseId: COURSE_ID, modifiedSince: BETWEEN });

    expect(body.notice).toMatch(/never conclude a file is absent/i);
    expect(body.notice).toMatch(/search_course/);
  });

  it("leaves the response without hidden fields when modifiedSince is not set", async () => {
    const { call } = hw12Course();
    const body = await call({ courseId: COURSE_ID });

    expect(JSON.stringify(body)).not.toContain("hiddenByFilter");
    expect(body).not.toHaveProperty("notice");
  });

  it("still keeps a module with unreadable children, children null", async () => {
    const { call } = setup({ 1: new ApiError(500, "/x", "boom") }, [mod(1, "M", OLD)]);
    const body = await call({ courseId: COURSE_ID, modifiedSince: BETWEEN });

    expect(body.contentTree[0].children).toBeNull();
    expect(body.contentTree[0]).not.toHaveProperty("hiddenByFilter");
    expect(body.notice).toMatch(/couldn't be read/);
  });
});

describe("get_course_content moduleTitle at any depth", () => {
  it("finds a nested module and returns its full subtree with a path", async () => {
    const { call } = hw12Course();
    const body = await call({ courseId: COURSE_ID, moduleTitle: "HW12" });

    expect(body.contentTree).toHaveLength(1);
    expect(body.contentTree[0].id).toBe(2);
    expect(body.contentTree[0].path).toBe("Homeworks > HW12");
    expect(body.contentTree[0].children.map((t: any) => t.id)).toEqual([10, 11]);
    expect(body).not.toHaveProperty("notice");
  });

  it("matches a top-level module as before, once, with its descendants inside it", async () => {
    const { call } = setup(
      { 1: [mod(2, "Week 1 Labs"), topic(5, "t", 1, OLD)], 4: [] },
      [mod(1, "Labs", OLD), mod(4, "Other", OLD)]
    );
    const body = await call({ courseId: COURSE_ID, moduleTitle: "labs" });

    expect(body.contentTree.map((m: any) => m.id)).toEqual([1]);
    expect(body.contentTree[0].path).toBe("Labs");
    expect(body.contentTree[0].children.map((c: any) => c.id)).toEqual([2, 5]);
    expect(body.moduleCount).toBe(2);
  });

  it("returns each matching module at different depths", async () => {
    const { call } = setup(
      { 1: [mod(2, "Lab 2")], 3: [] },
      [mod(1, "Homeworks"), mod(3, "Lab 1")]
    );
    const body = await call({ courseId: COURSE_ID, moduleTitle: "lab" });

    expect(body.contentTree.map((m: any) => m.path)).toEqual(["Homeworks > Lab 2", "Lab 1"]);
  });

  it("says no title matched at any level, and the module is not empty, when nothing matches", async () => {
    const { call } = hw12Course();
    const body = await call({ courseId: COURSE_ID, moduleTitle: "Quizzes" });

    expect(body.contentTree).toEqual([]);
    expect(body.notice).toMatch(/no module title matched at any level/i);
    expect(body.notice).toMatch(/not empty/i);
    expect(body.notice).toMatch(/search_course/);
  });

  it("respects maxDepth counted from the course root", async () => {
    const { call, requested } = setup(
      { 1: [mod(2, "HW12")], 2: [topic(10, "f", 1, OLD)] },
      [mod(1, "Homeworks")]
    );
    const body = await call({ courseId: COURSE_ID, moduleTitle: "HW12", maxDepth: 1 });

    expect(body.contentTree[0].path).toBe("Homeworks > HW12");
    expect(body.contentTree[0].children).toEqual([]);
    expect(requested.some((p) => p.includes("/modules/2/structure/"))).toBe(false);
  });

  it("fetches each module's structure once, no more than the full tree costs", async () => {
    const { call, requested } = hw12Course();
    await call({ courseId: COURSE_ID, moduleTitle: "HW12" });

    const structureCalls = requested.filter((p) => p.includes("/structure/"));
    expect(new Set(structureCalls).size).toBe(structureCalls.length);
    expect(structureCalls).toHaveLength(4);
  });

  it("keeps an unreadable matching module with childrenUnavailable", async () => {
    const { call } = setup({ 1: [mod(2, "HW12")], 2: new ApiError(403, "/x", "no") }, [mod(1, "Homeworks")]);
    const body = await call({ courseId: COURSE_ID, moduleTitle: "HW12" });

    expect(body.contentTree[0].children).toBeNull();
    expect(body.contentTree[0].childrenUnavailable.status).toBe(403);
    expect(body.notice).toMatch(/couldn't be read/);
  });
});

describe("get_course_content moduleTitle notices stay honest", () => {
  it("says an unreadable module may hold the match when nothing matched", async () => {
    const { call } = setup(
      { 1: new ApiError(403, "/x", "no"), 4: [mod(5, "Other")] },
      [mod(1, "Homeworks"), mod(4, "Labs")]
    );
    const body = await call({ courseId: COURSE_ID, moduleTitle: "HW12" });

    expect(body.contentTree).toEqual([]);
    expect(body.notice).toMatch(/1 module\(s\) couldn't be read/);
    expect(body.notice).toMatch(/match may be inside/i);
    expect(body.notice).toMatch(/try again/i);
  });

  it("flags an unreadable module that was walked past when other matches were found", async () => {
    const { call } = setup(
      { 1: new ApiError(500, "/x", "boom"), 4: [mod(5, "HW12")] },
      [mod(1, "Homeworks"), mod(4, "Labs")]
    );
    const body = await call({ courseId: COURSE_ID, moduleTitle: "HW12" });

    expect(body.contentTree.map((m: any) => m.path)).toEqual(["Labs > HW12"]);
    expect(body.notice).toMatch(/1 module\(s\) couldn't be read/);
    expect(body.notice).toMatch(/match may be inside/i);
  });

  it("counts an unreadable module inside a match once", async () => {
    const { call } = setup(
      { 1: [mod(2, "HW12")], 2: new ApiError(403, "/x", "no") },
      [mod(1, "Homeworks")]
    );
    const body = await call({ courseId: COURSE_ID, moduleTitle: "HW12" });

    expect(body.notice).toMatch(/1 module\(s\) couldn't be read/);
    expect(body.notice).not.toMatch(/match may be inside/i);
  });

  it("says only the first N levels were checked when maxDepth is set and nothing matched", async () => {
    const { call } = setup({ 1: [mod(2, "Sub")] }, [mod(1, "Homeworks")]);
    const body = await call({ courseId: COURSE_ID, moduleTitle: "HW12", maxDepth: 1 });

    expect(body.contentTree).toEqual([]);
    expect(body.notice).toMatch(/only the first 1 level/i);
    expect(body.notice).toMatch(/without maxDepth/i);
    expect(body.notice).not.toMatch(/at any level/i);
  });
});

describe("get_course_content modifiedSince notice wording", () => {
  it("does not claim every hidden topic is listed", async () => {
    const { call } = hw12Course();
    const body = await call({ courseId: COURSE_ID, modifiedSince: BETWEEN });

    expect(body.notice).not.toMatch(/modules list them/i);
    expect(body.notice).toMatch(/hiddenModulesByFilter/);
    expect(body.notice).toMatch(/left out/i);
    expect(body.notice).toMatch(/never conclude a file is absent/i);
  });
});
