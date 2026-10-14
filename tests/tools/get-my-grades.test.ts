import { describe, it, expect, vi } from "vitest";
import { registerGetMyGrades } from "../../src/tools/get-my-grades.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * The all-courses branch of get_my_grades resolves its course list from the
 * same paged myenrollments endpoint get_my_courses reads, and it has to respect
 * the same activeOnly policy. Reading a single page drops the courses after it;
 * pinning isActive=true into the query drops archived courses even when the
 * user configured activeOnly:false to ask for them.
 */

const COURSE_A = { Id: 101, Name: "CS 180", Code: "cs180" };
const COURSE_B = { Id: 202, Name: "MA 261", Code: "ma261" };

function makeConfig(activeOnly: boolean): AppConfig {
  return {
    baseUrl: "https://brightspace.example.edu",
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly },
  } as AppConfig;
}

type Responder = (path: string) => unknown;

function setup(respond: Responder, config: AppConfig = makeConfig(true)) {
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
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetMyGrades(server as any, apiClient as any, config);
  return { call: (args: unknown) => handler!(args), requested };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

const grade = (name: string) => ({
  GradeObjectIdentifier: name,
  GradeObjectName: name,
  DisplayedGrade: "95 %",
  PointsNumerator: 95,
  PointsDenominator: 100,
  WeightedNumerator: null,
  WeightedDenominator: null,
  Comments: null,
  PrivateComments: null,
  LastModified: "2026-09-01T00:00:00.000Z",
  ReleasedDate: null,
});

const enrollmentPage = (
  course: typeof COURSE_A,
  isActive: boolean,
  bookmark?: string
) => ({
  Items: [
    {
      OrgUnit: course,
      Access: { ClasslistRoleName: "Student", IsActive: isActive, LastAccessed: null },
    },
  ],
  PagingInfo: { HasMoreItems: bookmark !== undefined, Bookmark: bookmark ?? "" },
});

describe("get_my_grades all-courses course resolution", () => {
  it("returns grades for courses on every page of enrollments", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) {
        return path.includes("bookmark=b1")
          ? enrollmentPage(COURSE_B, true)
          : enrollmentPage(COURSE_A, true, "b1");
      }
      if (path.includes(`/${COURSE_A.Id}/grades/`)) return [grade("Exam 1")];
      if (path.includes(`/${COURSE_B.Id}/grades/`)) return [grade("Quiz 2")];
      return [];
    });

    const payload = parse(await call({}));
    expect(payload.courses.map((c: { courseId: number }) => c.courseId)).toEqual([
      COURSE_A.Id,
      COURSE_B.Id,
    ]);
  });

  it("honours a configured activeOnly:false instead of forcing isActive=true", async () => {
    // Stand in for the server: isActive=true really does withhold the archived
    // course, so a hardcoded filter loses it before applyCourseFilter is asked.
    const { call, requested } = setup((path) => {
      if (path.includes("/enrollments/")) {
        if (path.includes("isActive=true")) return { Items: [] };
        return enrollmentPage(COURSE_B, false);
      }
      if (path.includes(`/${COURSE_B.Id}/grades/`)) return [grade("Final")];
      return [];
    }, makeConfig(false));

    const payload = parse(await call({}));
    expect(requested[0]).not.toContain("isActive=true");
    expect(payload.courses.map((c: { courseId: number }) => c.courseId)).toEqual([
      COURSE_B.Id,
    ]);
  });

  it("keeps asking for isActive=true under the default policy", async () => {
    const { call, requested } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollmentPage(COURSE_A, true);
      return [grade("Exam 1")];
    });

    await call({});
    expect(requested[0]).toContain("isActive=true");
  });

  it("returns a single course's grades without touching enrollments", async () => {
    const { call, requested } = setup(() => [grade("Homework 1")]);

    const payload = parse(await call({ courseId: COURSE_A.Id }));
    expect(payload.courseId).toBe(COURSE_A.Id);
    expect(payload.grades).toHaveLength(1);
    expect(requested.some((p) => p.includes("/enrollments/"))).toBe(false);
  });
});

/**
 * A sign-in that has not finished is not an empty gradebook. CLAUDE.md forbids
 * turning a previously successful `{grades: []}` response into an error, so
 * the tool keeps the success envelope and adds an explicit authPending/notice
 * pair a caller can check instead.
 */

import { AuthProcessError } from "../../src/auth/auth-runner.js";
import { ApiError } from "../../src/api/errors.js";

const mfaPending = () => new AuthProcessError("mfaPending", "MFA approval pending");

describe("get_my_grades while sign-in is pending", () => {
  it("reports authPending for a single course instead of an empty list read as success", async () => {
    const { call } = setup(() => {
      throw mfaPending();
    });

    const result = await call({ courseId: COURSE_A.Id });

    expect(result.isError).toBeUndefined();
    const parsed = parse(result);
    expect(parsed).toMatchObject({ courseId: COURSE_A.Id, grades: [], authPending: true });
    expect(parsed.notice).toContain("Approve the sign-in request");
  });

  it("reports authPending when the grades route is rejected with 401", async () => {
    const { call } = setup((path) => {
      if (path.includes("/grades/")) throw new ApiError(401, path, "expired");
      return [];
    });

    const result = await call({ courseId: COURSE_A.Id });

    expect(result.isError).toBeUndefined();
    const parsed = parse(result);
    expect(parsed).toMatchObject({ courseId: COURSE_A.Id, grades: [], authPending: true });
    expect(parsed.notice).toContain("Authentication expired");
  });

  it("still returns the other course when a non-auth failure hits one course", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) {
        return { Items: [{ OrgUnit: COURSE_A, Access: { IsActive: true } }, { OrgUnit: COURSE_B, Access: { IsActive: true } }] };
      }
      if (path.includes(`/${COURSE_B.Id}/grades/`)) {
        throw new ApiError(403, path, "Forbidden");
      }
      return [grade("Exam 1")];
    });

    const result = await call({});

    expect(result.isError).toBeUndefined();
    const parsed = parse(result);
    expect(parsed.authPending).toBeUndefined();
    expect(parsed.courses.map((c: any) => c.courseId)).toEqual([COURSE_A.Id]);
  });

  it("keeps the courses that answered when only one course's sign-in is pending", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) {
        return { Items: [{ OrgUnit: COURSE_A, Access: { IsActive: true } }, { OrgUnit: COURSE_B, Access: { IsActive: true } }] };
      }
      if (path.includes(`/${COURSE_B.Id}/grades/`)) throw mfaPending();
      return [grade("Exam 1")];
    });

    const result = await call({});

    expect(result.isError).toBeUndefined();
    const parsed = parse(result);
    expect(parsed.authPending).toBe(true);
    expect(parsed.unavailableCourseIds).toEqual([COURSE_B.Id]);

    const answered = parsed.courses.find((c: any) => c.courseId === COURSE_A.Id);
    expect(answered.grades).toHaveLength(1);
    expect(answered.authPending).toBeUndefined();

    const pending = parsed.courses.find((c: any) => c.courseId === COURSE_B.Id);
    expect(pending).toEqual({ courseId: COURSE_B.Id, courseName: COURSE_B.Name, grades: [], authPending: true });
  });
});

/**
 * A 403 on a course's /grades/values/myGradeValues/ means the tenant
 * restricts the grade API for that course (a common institutional policy,
 * not a bug). Dropping the course from `courses` with no trace left a
 * student unable to tell "no grades yet" apart from "the server couldn't see
 * this course at all". A new, purely additive `restrictedCourses` array
 * carries exactly the courses that 403'd, each with a link back into the
 * Brightspace gradebook; `courses` itself is unchanged.
 */
const forbidden = () => Object.assign(new Error("Forbidden"), { status: 403 });

describe("get_my_grades grade-restricted courses", () => {
  it("lists a 403'd course in restrictedCourses and leaves courses otherwise unchanged", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) {
        return { Items: [enrollmentPage(COURSE_A, true).Items[0], enrollmentPage(COURSE_B, true).Items[0]] };
      }
      if (path.includes(`/${COURSE_A.Id}/grades/`)) throw forbidden();
      if (path.includes(`/${COURSE_B.Id}/grades/`)) return [grade("Quiz 2")];
      return [];
    });

    const payload = parse(await call({}));

    expect(payload.courses).toMatchObject([
      { courseId: COURSE_B.Id, courseName: COURSE_B.Name, grades: [grade("Quiz 2")].map((gv) => ({
        name: gv.GradeObjectName,
        displayGrade: gv.DisplayedGrade,
        pointsNumerator: gv.PointsNumerator,
        pointsDenominator: gv.PointsDenominator,
        weightedNumerator: gv.WeightedNumerator,
        weightedDenominator: gv.WeightedDenominator,
        comments: null,
        lastModified: gv.LastModified,
      })) },
    ]);
    expect(payload.restrictedCourses).toEqual([
      {
        courseId: COURSE_A.Id,
        courseName: COURSE_A.Name,
        gradeUrl: "https://brightspace.example.edu/d2l/lms/grades/my_grades/main.d2l?ou=101",
      },
    ]);
  });

  it("emits an empty restrictedCourses array, not an omitted field, when nothing 403'd", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollmentPage(COURSE_A, true);
      if (path.includes(`/${COURSE_A.Id}/grades/`)) return [grade("Exam 1")];
      return [];
    });

    const payload = parse(await call({}));

    expect(payload).toHaveProperty("restrictedCourses");
    expect(payload.restrictedCourses).toEqual([]);
  });

  it("names the gradebook URL in the single-course 403 error without changing the error shape", async () => {
    const { call } = setup(() => {
      throw forbidden();
    });

    const result = await call({ courseId: COURSE_A.Id });

    // Shape is unchanged: still a plain isError result with one text block.
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain(
      "https://brightspace.example.edu/d2l/lms/grades/my_grades/main.d2l?ou=101"
    );
  });
});

/**
 * A failure other than 403 or a pending sign-in (a 404, a 5xx, a dropped
 * connection) used to be rethrown inside the per-course promise and filtered
 * out by allSettled, so the course disappeared with nothing saying so (#245).
 */
describe("get_my_grades courses whose grades fail to load", () => {
  const twoCourses = (failure: () => never) =>
    setup((path) => {
      if (path.includes("/enrollments/")) {
        return { Items: [enrollmentPage(COURSE_A, true).Items[0], enrollmentPage(COURSE_B, true).Items[0]] };
      }
      if (path.includes(`/${COURSE_B.Id}/grades/`)) failure();
      if (path.includes("/grades/")) return [grade("Exam 1")];
      return [];
    });

  it("lists a course whose grades answer 500 in failedCourses instead of dropping it", async () => {
    const { call } = twoCourses(() => {
      throw new ApiError(500, "/grades/", "Internal Server Error");
    });

    const result = await call({});

    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    expect(payload.courses.map((c: any) => c.courseId)).toEqual([COURSE_A.Id]);
    expect(payload.restrictedCourses).toEqual([]);
    expect(payload.failedCourses).toEqual([
      {
        courseId: COURSE_B.Id,
        courseName: COURSE_B.Name,
        gradeUrl: "https://brightspace.example.edu/d2l/lms/grades/my_grades/main.d2l?ou=202",
      },
    ]);
    expect(payload.notice).toContain(String(COURSE_B.Id));
    expect(payload.authPending).toBeUndefined();
  });

  it("keeps a course whose grade request dies on the network", async () => {
    const { call } = twoCourses(() => {
      throw new TypeError("fetch failed");
    });

    const payload = parse(await call({}));

    expect(payload.failedCourses.map((c: any) => c.courseId)).toEqual([COURSE_B.Id]);
  });

  it("leaves failedCourses and notice out when every course answered", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollmentPage(COURSE_A, true);
      if (path.includes(`/${COURSE_A.Id}/grades/`)) return [grade("Exam 1")];
      return [];
    });

    const payload = parse(await call({}));

    expect(payload).not.toHaveProperty("failedCourses");
    expect(payload).not.toHaveProperty("notice");
  });

  it("carries both notices when one course is pending sign-in and another failed", async () => {
    const COURSE_C = { Id: 303, Name: "PHYS 172", Code: "phys172" };
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) {
        return {
          Items: [
            enrollmentPage(COURSE_A, true).Items[0],
            enrollmentPage(COURSE_B, true).Items[0],
            enrollmentPage(COURSE_C, true).Items[0],
          ],
        };
      }
      if (path.includes(`/${COURSE_B.Id}/grades/`)) throw mfaPending();
      if (path.includes(`/${COURSE_C.Id}/grades/`)) throw new ApiError(404, path, "Not Found");
      if (path.includes("/grades/")) return [grade("Exam 1")];
      return [];
    });

    const payload = parse(await call({}));

    expect(payload.authPending).toBe(true);
    expect(payload.unavailableCourseIds).toEqual([COURSE_B.Id]);
    expect(payload.failedCourses.map((c: any) => c.courseId)).toEqual([COURSE_C.Id]);
    expect(payload.notice).toContain("Sign-in to Brightspace is still in progress");
    expect(payload.notice).toContain("failedCourses");
    expect(payload.courses.map((c: any) => c.courseId)).toEqual([COURSE_A.Id, COURSE_B.Id]);
  });
});

/**
 * A grade row linked to a quiz can carry feedback the gradebook does not: the
 * quiz's own submissions page may hold it, sometimes behind a restricted viewer
 * such as Respondus LockDown Browser. The student API cannot read that
 * feedback, so a null `comments` on such a row must not read as "no feedback".
 * Quiz-linked rows keep their quiz source; other rows use the gradebook source.
 */
describe("get_my_grades quiz feedback source", () => {
  const QUIZ = { QuizId: 77, Name: "Midterm", GradeItemId: 5001, IsActive: true };
  const quizGrade = { ...grade("Midterm"), GradeObjectIdentifier: "5001" };
  const quizUrl = "https://brightspace.example.edu/d2l/lms/quizzing/user/quiz_summary.d2l?qi=77&ou=101";

  const respond = (grades: unknown[], quizzes: unknown = { Objects: [QUIZ] }) => (path: string) => {
    if (path.includes("/enrollments/")) return enrollmentPage(COURSE_A, true);
    if (path.includes("/quizzes/")) return quizzes;
    return grades;
  };

  it("links a quiz grade to its quiz page", async () => {
    const { call } = setup(respond([quizGrade]));

    const [row] = parse(await call({ courseId: COURSE_A.Id })).grades;

    expect(row.feedbackUrl).toBe(quizUrl);
  });

  it("notes that feedback may exist on the quiz when the gradebook has no comment", async () => {
    const { call } = setup(respond([quizGrade]));

    const [row] = parse(await call({ courseId: COURSE_A.Id })).grades;

    expect(row.comments).toBeNull();
    expect(row.feedbackNote).toMatch(/LockDown Browser/);
  });

  it("omits the note when the gradebook already carries a comment", async () => {
    const commented = { ...quizGrade, Comments: { Text: "Nice work", Html: "<p>Nice work</p>" } };
    const { call } = setup(respond([commented]));

    const [row] = parse(await call({ courseId: COURSE_A.Id })).grades;

    expect(row.feedbackNote).toBeUndefined();
  });

  it("links quiz grades in the all-courses result too", async () => {
    const { call } = setup(respond([quizGrade]));

    const [row] = parse(await call({})).courses[0].grades;

    expect(row.feedbackUrl).toBe(quizUrl);
  });

  it("keeps a gradebook source when no quiz is linked", async () => {
    const { call } = setup(respond([grade("Homework 1")]));

    const [row] = parse(await call({ courseId: COURSE_A.Id })).grades;

    expect(row.feedbackUrl).toBe("https://brightspace.example.edu/d2l/lms/grades/my_grades/main.d2l?ou=101");
    expect(row.feedbackNote).toBeUndefined();
  });

  it("keeps quiz sources and normalized HTML comments together", async () => {
    const { call } = setup(respond([{ ...quizGrade, Comments: { Text: "", Html: "<p><strong>Good</strong> evidence</p>" } }]));
    const [row] = parse(await call({ courseId: COURSE_A.Id })).grades;
    expect(row).toMatchObject({ comments: "**Good** evidence", feedbackUrl: quizUrl, feedbackStatus: "retrieved", gradeObjectId: "5001" });
    expect(row.feedbackNote).toBeUndefined();
    expect(row.feedbackStatusNote).toBeUndefined();
  });

  it("still returns grades when the quiz list is refused", async () => {
    const { call } = setup((path) => {
      if (path.includes("/quizzes/")) throw Object.assign(new Error("Forbidden"), { status: 403 });
      return [quizGrade];
    });

    const payload = parse(await call({ courseId: COURSE_A.Id }));

    expect(payload.grades.map((g: { name: string }) => g.name)).toEqual(["Midterm"]);
  });
});

describe("get_my_grades public instructor feedback", () => {
  it.each([false, true])("preserves HTML comments in single/all courses (all=%s)", async (all) => {
    const { call } = setup((path) => path.includes("/enrollments/")
      ? enrollmentPage(COURSE_A, true)
      : [{ ...grade("Quiz"), Comments: { Text: "", Html: "<p><strong>Good</strong> reasoning.</p>" } }]);
    const result = parse(await call(all ? {} : { courseId: COURSE_A.Id }));
    const row = all ? result.courses[0].grades[0] : result.grades[0];
    expect(row).toMatchObject({ comments: "**Good** reasoning.", feedbackStatus: "retrieved", gradeObjectId: "Quiz" });
    expect(row.feedbackUrl).toContain("ou=101");
    expect(row.feedbackStatusNote).toBeUndefined();
  });

  it("does not confuse absent public comments with absent published feedback or expose private comments", async () => {
    const { call } = setup(() => [{ ...grade("Quiz"), PrivateComments: { Text: "private", Html: "<p>private</p>" } }]);
    const result = parse(await call({ courseId: COURSE_A.Id }));
    expect(result.grades[0]).toMatchObject({ comments: null, feedbackStatus: "unavailable" });
    expect(result.grades[0].feedbackStatusNote).toContain("do not interpret null as no feedback");
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
