import { describe, it, expect, vi } from "vitest";
import { registerGetAssignments } from "../../src/tools/get-assignments.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Quiz coverage.
 *
 * get_assignments finds quizzes three ways: the quiz list, quiz topics in the
 * course content, and gradebook columns nothing else matched. When any of
 * those reads fails, the quizzes it would have found are silently missing, so
 * each course says whether its quiz inventory is complete or not, instead of
 * letting a short list pass for the whole one.
 */

const BASE = "https://brightspace.example.edu";
const COURSE = { Id: 101, Name: "CS 180", Code: "cs180" };

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
const forbidden = () => Object.assign(new Error("Forbidden"), { status: 403 });
const serverError = () => Object.assign(new Error("Server Error"), { status: 500 });

const config = {
  baseUrl: BASE,
  sessionDir: "/tmp/nope",
  tokenTtl: 3600,
  headless: true,
  courseFilter: { activeOnly: true },
} as AppConfig;

type Route = "quizzes" | "toc" | "grades";

/** A course with one quiz; the routes named in `failing` throw the given error. */
function setupTool(failing: Partial<Record<Route, () => Error>> = {}) {
  const apiClient = {
    lp: (p: string) => `/d2l/api/lp/1.0${p}`,
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      if (path.includes("/enrollments/")) {
        return {
          Items: [{ OrgUnit: COURSE, Access: { ClasslistRoleName: "Student", IsActive: true, LastAccessed: null } }],
          PagingInfo: { HasMoreItems: false },
        };
      }
      if (path.endsWith("/quizzes/")) {
        if (failing.quizzes) throw failing.quizzes();
        return { Objects: [{ QuizId: 66, Name: "Quiz 1", IsActive: true }] };
      }
      if (path.endsWith("/content/toc")) {
        if (failing.toc) throw failing.toc();
        return { Modules: [] };
      }
      if (path.endsWith("/grades/")) {
        if (failing.grades) throw failing.grades();
        return [];
      }
      if (path.endsWith("/dropbox/folders/")) return [];
      throw notFound();
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };
  registerGetAssignments(server as any, apiClient as any, config);
  return (args: unknown) => handler!(args).then((r: any) => JSON.parse(r.content[0].text));
}

describe("get_assignments quiz coverage", () => {
  it("reports complete coverage when every quiz source answered", async () => {
    const result = await setupTool()({ courseId: COURSE.Id });

    expect(result.quizCoverage).toBe("complete");
  });

  it("carries no coverage note when coverage is complete", async () => {
    const result = await setupTool()({ courseId: COURSE.Id });

    expect(result).not.toHaveProperty("quizCoverageNote");
  });

  it("reports incomplete coverage when the quiz list could not be read", async () => {
    const result = await setupTool({ quizzes: serverError })({ courseId: COURSE.Id });

    expect(result.quizCoverage).toBe("incomplete");
  });

  it("names the unread quiz list in the coverage note", async () => {
    const result = await setupTool({ quizzes: forbidden })({ courseId: COURSE.Id });

    expect(result.quizCoverageNote).toMatch(/quiz list/i);
  });

  it("reports incomplete coverage when the gradebook could not be cross-checked", async () => {
    const result = await setupTool({ grades: forbidden })({ courseId: COURSE.Id });

    expect(result.quizCoverage).toBe("incomplete");
  });

  it("names the unread gradebook in the coverage note", async () => {
    const result = await setupTool({ grades: forbidden })({ courseId: COURSE.Id });

    expect(result.quizCoverageNote).toMatch(/gradebook/i);
  });

  it("reports incomplete coverage when course content could not be cross-checked", async () => {
    const result = await setupTool({ toc: serverError })({ courseId: COURSE.Id });

    expect(result.quizCoverage).toBe("incomplete");
  });

  it("tells the caller not to treat an unlisted quiz as missing or not taken", async () => {
    const result = await setupTool({ quizzes: serverError })({ courseId: COURSE.Id });

    expect(result.quizCoverageNote).toMatch(/do not/i);
  });

  it("keeps the quizzes that were found when coverage is incomplete", async () => {
    const result = await setupTool({ grades: forbidden })({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => a.name)).toEqual(["Quiz 1"]);
  });

  it("reports coverage per course when listing every course", async () => {
    const result = await setupTool({ quizzes: serverError })({});

    expect(result.courses.map((c: any) => c.quizCoverage)).toEqual(["incomplete"]);
  });
});
