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
const badRequest = () => Object.assign(new Error("Bad Request"), { status: 400 });
const serverError = () => Object.assign(new Error("Server Error"), { status: 500 });
const networkDown = () => new Error("fetch failed");

const config = {
  baseUrl: BASE,
  sessionDir: "/tmp/nope",
  tokenTtl: 3600,
  headless: true,
  courseFilter: { activeOnly: true },
} as AppConfig;

const LE = `/d2l/api/le/1.0/${COURSE.Id}`;
const TOC_DATED = `${LE}/content/toc?ignoreDateRestrictions=true&ignoreModuleDateRestrictions=true`;
const TOC_PLAIN = `${LE}/content/toc`;

/** "toc" is the date-inclusive table of contents, "tocPlain" the default view. */
type Route = "quizzes" | "toc" | "tocPlain" | "grades";

/** A course with one quiz; the routes named in `failing` throw the given error. */
function setupTool(failing: Partial<Record<Route, () => Error>> = {}) {
  const requested: string[] = [];
  const apiClient = {
    lp: (p: string) => `/d2l/api/lp/1.0${p}`,
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      if (path.includes("/enrollments/")) {
        return {
          Items: [{ OrgUnit: COURSE, Access: { ClasslistRoleName: "Student", IsActive: true, LastAccessed: null } }],
          PagingInfo: { HasMoreItems: false },
        };
      }
      if (path === `${LE}/quizzes/`) {
        if (failing.quizzes) throw failing.quizzes();
        return { Objects: [{ QuizId: 66, Name: "Quiz 1", IsActive: true }] };
      }
      if (path === TOC_DATED) {
        if (failing.toc) throw failing.toc();
        return { Modules: [] };
      }
      if (path === TOC_PLAIN) {
        if (failing.tocPlain) throw failing.tocPlain();
        return { Modules: [] };
      }
      if (path === `${LE}/grades/`) {
        if (failing.grades) throw failing.grades();
        return [];
      }
      if (path === `${LE}/dropbox/folders/`) return [];
      throw notFound();
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  let description = "";
  const server = {
    registerTool: (_n: string, meta: { description: string }, fn: (args: unknown) => Promise<any>) => {
      description = meta.description;
      handler = fn;
    },
  };
  registerGetAssignments(server as any, apiClient as any, config);
  const call = (args: unknown) => handler!(args).then((r: any) => JSON.parse(r.content[0].text));
  return { call, requested, description: () => description };
}

/** The note with each source's parenthetical explanation removed, leaving only the sources it names. */
const namedSources = (note: string) => note.replace(/\([^)]*\)/g, "");

const run = (failing: Partial<Record<Route, () => Error>> = {}) =>
  setupTool(failing).call({ courseId: COURSE.Id });

describe("get_assignments quiz coverage", () => {
  it("reports complete coverage when every quiz source answered", async () => {
    expect((await run()).quizCoverage).toBe("complete");
  });

  it("carries no coverage note when coverage is complete", async () => {
    expect(await run()).not.toHaveProperty("quizCoverageNote");
  });

  it("reports incomplete coverage when the quiz list could not be read", async () => {
    expect((await run({ quizzes: serverError })).quizCoverage).toBe("incomplete");
  });

  it("names only the quiz list when only the quiz list failed", async () => {
    const result = await run({ quizzes: forbidden });

    expect(result.quizCoverageNote).toMatch(/^Brightspace did not return the course's quiz list, so /);
    expect(namedSources(result.quizCoverageNote)).not.toMatch(/gradebook|course content|date/i);
  });

  it("names only the gradebook when only the gradebook failed", async () => {
    const result = await run({ grades: forbidden });

    expect(result.quizCoverage).toBe("incomplete");
    expect(result.quizCoverageNote).toMatch(/^Brightspace did not return the gradebook \(/);
    expect(namedSources(result.quizCoverageNote)).not.toMatch(/quiz list|course content|date/i);
  });

  it("names only the course content when the date-inclusive table of contents failed hard", async () => {
    const result = await run({ toc: serverError });

    expect(result.quizCoverage).toBe("incomplete");
    expect(result.quizCoverageNote).toMatch(/^Brightspace did not return the course content \(/);
    expect(namedSources(result.quizCoverageNote)).not.toMatch(/quiz list|gradebook|date-restricted/i);
  });

  it("names only the course content when both table of contents requests failed", async () => {
    const result = await run({ toc: badRequest, tocPlain: serverError });

    expect(result.quizCoverageNote).toMatch(/^Brightspace did not return the course content \(/);
    expect(namedSources(result.quizCoverageNote)).not.toMatch(/quiz list|gradebook|date-restricted/i);
  });

  it("names only the date-restricted view when the plain table of contents had to stand in", async () => {
    const result = await run({ toc: badRequest });

    expect(result.quizCoverage).toBe("incomplete");
    expect(result.quizCoverageNote).toMatch(/^Brightspace did not return the course content with date-restricted items included \(/);
    expect(namedSources(result.quizCoverageNote)).not.toMatch(/quiz list|gradebook/i);
  });

  it("names every source that failed, and only those", async () => {
    const result = await run({ quizzes: serverError, grades: serverError });

    expect(namedSources(result.quizCoverageNote)).toMatch(/quiz list/);
    expect(namedSources(result.quizCoverageNote)).toMatch(/gradebook/);
    expect(namedSources(result.quizCoverageNote)).not.toMatch(/course content/);
  });

  it("tells the caller not to treat an unlisted quiz as missing or not taken", async () => {
    const result = await run({ quizzes: serverError });

    expect(result.quizCoverageNote).toMatch(/do not report an unlisted quiz as missing or not taken/i);
  });

  it("keeps the quizzes that were found when coverage is incomplete", async () => {
    const result = await run({ grades: forbidden });

    expect(result.assignments.map((a: any) => a.name)).toEqual(["Quiz 1"]);
  });

  it("reports coverage per course when listing every course", async () => {
    const result = await setupTool({ quizzes: serverError }).call({});

    expect(result.courses.map((c: any) => c.quizCoverage)).toEqual(["incomplete"]);
  });
});

describe("get_assignments quiz coverage: a course without the quiz tool", () => {
  it("counts a 404 on the quiz list as answered and empty, so coverage stays complete", async () => {
    const result = await run({ quizzes: notFound });

    expect(result.quizCoverage).toBe("complete");
    expect(result).not.toHaveProperty("quizCoverageNote");
    expect(result.assignments).toEqual([]);
  });

  it.each([
    ["403", forbidden],
    ["500", serverError],
    ["a network failure", networkDown],
  ])("keeps coverage incomplete when the quiz list fails with %s", async (_what, error) => {
    expect((await run({ quizzes: error })).quizCoverage).toBe("incomplete");
  });
});

describe("get_assignments tool description", () => {
  const text = () => setupTool().description();

  it("says complete coverage means every source answered, not that every quiz is listed", () => {
    expect(text()).toMatch(/"complete" means every quiz source answered/);
    expect(text()).toMatch(/not that every quiz is guaranteed to be listed/);
  });

  it("says incomplete coverage means a source could not be read", () => {
    expect(text()).toMatch(/"incomplete" means a quiz source could not be read/);
  });

  it("forbids concluding that an absent quiz was missed or not taken", () => {
    expect(text()).toMatch(/never conclude that a quiz was missed or not taken because it is absent/i);
  });

  it("explains that a gradeOnly row named like a quiz is a quiz whose details could not be read", () => {
    expect(text()).toMatch(/gradeOnly row named like a quiz is a quiz whose details could not be read/i);
  });
});
