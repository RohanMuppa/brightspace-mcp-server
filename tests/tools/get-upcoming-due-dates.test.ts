import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerGetUpcomingDueDates } from "../../src/tools/get-upcoming-due-dates.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Regression tests for issue #18: get_upcoming_due_dates used the D2L calendar
 * feed, which emits a separate "availability starts" event for quizzes. A quiz
 * whose window opened today but was due in five days was reported as due today.
 * The tool now reads DueDate straight off dropbox folders and quizzes.
 */

const BASE = "https://brightspace.example.edu";
const NOW = new Date("2026-09-02T12:00:00.000Z");

const daysFromNow = (days: number): string =>
  new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

const COURSE_A = { Id: 101, Name: "CS 180", Code: "cs180" };
const COURSE_B = { Id: 202, Name: "MA 261", Code: "ma261" };

function makeConfig(): AppConfig {
  return {
    baseUrl: BASE,
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly: true },
  } as AppConfig;
}

type Responder = (path: string) => unknown;

/** Captures the registered handler; `respond` maps a request path to its payload. */
function setup(respond: Responder, config: AppConfig = makeConfig()) {
  const requested: string[] = [];
  const apiClient = {
    lp: (p: string) => `/d2l/api/lp/1.0${p}`,
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return respond(path);
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_name: string, _meta: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetUpcomingDueDates(server as any, apiClient as any, config);
  return { call: (args: unknown) => handler!(args), requested };
}

const enrollments = (...courses: Array<typeof COURSE_A>) => ({
  Items: courses.map((c) => ({
    OrgUnit: c,
    Access: { ClasslistRoleName: "Student", IsActive: true, LastAccessed: null },
  })),
});

const parse = (result: any): any[] => JSON.parse(result.content[0].text);

const forbidden = () => Object.assign(new Error("Forbidden"), { status: 403 });

describe("get_upcoming_due_dates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the quiz DueDate, not its StartDate (issue #18)", async () => {
    const quiz = {
      QuizId: 7,
      Name: "Quiz 3",
      StartDate: daysFromNow(1),
      EndDate: daysFromNow(6),
      DueDate: daysFromNow(5),
      IsActive: true,
    };
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/quizzes/")) return { Objects: [quiz] };
      return { Objects: [] };
    });

    const narrow = parse(await call({ daysAhead: 3 }));
    expect(narrow).toEqual([]);

    const wide = parse(await call({ daysAhead: 7 }));
    expect(wide).toHaveLength(1);
    expect(wide[0]).toMatchObject({
      type: "quiz",
      id: 7,
      title: "Quiz 3",
      courseId: 101,
      courseName: "CS 180",
      dueDate: quiz.DueDate,
      startDate: quiz.StartDate,
      endDate: quiz.EndDate,
    });
  });

  it("falls back to EndDate when a quiz has no DueDate", async () => {
    const quiz = {
      QuizId: 8,
      Name: "Quiz 4",
      StartDate: null,
      EndDate: daysFromNow(2),
      DueDate: null,
      IsActive: true,
    };
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/quizzes/")) return [quiz];
      return [];
    });

    const items = parse(await call({ daysAhead: 7 }));
    expect(items).toHaveLength(1);
    expect(items[0].dueDate).toBe(quiz.EndDate);
  });

  it("skips hidden dropbox folders, inactive quizzes, and items with no due date", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/dropbox/folders/")) {
        return [
          { Id: 1, Name: "Visible HW", DueDate: daysFromNow(1), IsHidden: false },
          { Id: 2, Name: "Hidden HW", DueDate: daysFromNow(1), IsHidden: true },
          { Id: 3, Name: "No due date", DueDate: null, IsHidden: false },
        ];
      }
      if (path.includes("/quizzes/")) {
        return [
          { QuizId: 10, Name: "Active", StartDate: null, EndDate: null, DueDate: daysFromNow(2), IsActive: true },
          { QuizId: 11, Name: "Inactive", StartDate: null, EndDate: null, DueDate: daysFromNow(2), IsActive: false },
          { QuizId: 12, Name: "Undated", StartDate: null, EndDate: null, DueDate: null, IsActive: true },
        ];
      }
      return [];
    });

    const items = parse(await call({ daysAhead: 7 }));
    expect(items.map((i) => `${i.type}:${i.id}`)).toEqual(["assignment:1", "quiz:10"]);
  });

  it("parses both a bare array and an { Objects } wrapper", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/dropbox/folders/")) {
        return [{ Id: 1, Name: "Bare", DueDate: daysFromNow(1), IsHidden: false }];
      }
      if (path.includes("/quizzes/")) {
        return {
          Objects: [
            { QuizId: 2, Name: "Wrapped", StartDate: null, EndDate: null, DueDate: daysFromNow(2), IsActive: true },
          ],
        };
      }
      return [];
    });

    const items = parse(await call({ daysAhead: 7 }));
    expect(items.map((i) => i.title)).toEqual(["Bare", "Wrapped"]);
  });

  it("keeps the other course's items when one course returns 403", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A, COURSE_B);
      if (path.includes(`/${COURSE_B.Id}/`)) throw forbidden();
      if (path.includes("/dropbox/folders/")) {
        return [{ Id: 1, Name: "HW 1", DueDate: daysFromNow(1), IsHidden: false }];
      }
      return [];
    });

    const items = parse(await call({ daysAhead: 7 }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ courseId: 101, courseName: "CS 180", title: "HW 1" });
  });

  it("sorts ascending by dueDate across courses and item types", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A, COURSE_B);
      if (path.includes(`/${COURSE_A.Id}/dropbox/`)) {
        return [{ Id: 1, Name: "Due day 5", DueDate: daysFromNow(5), IsHidden: false }];
      }
      if (path.includes(`/${COURSE_A.Id}/quizzes/`)) {
        return [{ QuizId: 2, Name: "Due day 1", StartDate: null, EndDate: null, DueDate: daysFromNow(1), IsActive: true }];
      }
      if (path.includes(`/${COURSE_B.Id}/dropbox/`)) {
        return [{ Id: 3, Name: "Due day 3", DueDate: daysFromNow(3), IsHidden: false }];
      }
      if (path.includes(`/${COURSE_B.Id}/quizzes/`)) {
        return [{ QuizId: 4, Name: "Due day 9", StartDate: null, EndDate: null, DueDate: daysFromNow(9), IsActive: true }];
      }
      return [];
    });

    const items = parse(await call({ daysAhead: 7 }));
    expect(items.map((i) => i.title)).toEqual(["Due day 1", "Due day 3", "Due day 5"]);
  });

  it("excludes items already past due", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/dropbox/folders/")) {
        return [{ Id: 1, Name: "Late", DueDate: daysFromNow(-1), IsHidden: false }];
      }
      return [];
    });

    expect(parse(await call({ daysAhead: 7 }))).toEqual([]);
  });

  it("emits deep-link urls for assignments and quizzes", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/dropbox/folders/")) {
        return [{ Id: 55, Name: "HW", DueDate: daysFromNow(1), IsHidden: false }];
      }
      if (path.includes("/quizzes/")) {
        return [{ QuizId: 66, Name: "Q", StartDate: null, EndDate: null, DueDate: daysFromNow(2), IsActive: true }];
      }
      return [];
    });

    const [assignment, quiz] = parse(await call({ daysAhead: 7 }));
    expect(assignment.url).toBe(
      `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=55&grpid=0&ou=101`
    );
    expect(assignment.startDate).toBeNull();
    expect(assignment.endDate).toBeNull();
    expect(quiz.url).toBe(`${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=66&ou=101`);
  });

  it("queries only the requested course when courseId is given and still names it", async () => {
    const { call, requested } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A, COURSE_B);
      if (path.includes("/dropbox/folders/")) {
        return [{ Id: 1, Name: "HW", DueDate: daysFromNow(1), IsHidden: false }];
      }
      return [];
    });

    const items = parse(await call({ daysAhead: 7, courseId: COURSE_B.Id }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ courseId: 202, courseName: "MA 261" });
    expect(requested.some((p) => p.includes(`/${COURSE_A.Id}/`))).toBe(false);
  });

  it("does not call submission, feedback, or attempt endpoints", async () => {
    const { call, requested } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/dropbox/folders/")) {
        return [{ Id: 1, Name: "HW", DueDate: daysFromNow(1), IsHidden: false }];
      }
      if (path.includes("/quizzes/")) {
        return [{ QuizId: 2, Name: "Q", StartDate: null, EndDate: null, DueDate: daysFromNow(2), IsActive: true }];
      }
      return [];
    });

    await call({ daysAhead: 7 });
    expect(requested.filter((p) => /submissions|feedback|attempts/.test(p))).toEqual([]);
    expect(requested.filter((p) => p.includes(`/${COURSE_A.Id}/`))).toHaveLength(2);
  });
});
