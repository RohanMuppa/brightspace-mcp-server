import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchCourseAssignments } from "../../src/tools/get-assignments.js";

/**
 * fetchCourseAssignments takes baseUrl as an optional trailing argument so the
 * dropbox and quiz results can carry a deep link back into Brightspace.
 */

const BASE = "https://brightspace.example.edu";
const COURSE_ID = 101;

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
const forbidden = () => Object.assign(new Error("Forbidden"), { status: 403 });

/** Mocked client: only the folder and quiz listings return rows. */
function makeApiClient() {
  return {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/dropbox/folders/")) {
        return [{ Id: 55, Name: "HW 1", DueDate: null, IsHidden: false, GroupTypeId: null }];
      }
      if (path.endsWith("/quizzes/")) {
        return { Objects: [{ QuizId: 66, Name: "Quiz 1", IsActive: true }] };
      }
      throw notFound();
    }),
  };
}

describe("fetchCourseAssignments", () => {
  it("adds deep-link urls when baseUrl is supplied", async () => {
    const assignments = await fetchCourseAssignments(
      makeApiClient() as any,
      COURSE_ID,
      BASE
    );

    expect(assignments.map((a) => a.url)).toEqual([
      `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=55&grpid=0&ou=101`,
      `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=66&ou=101`,
    ]);
  });

  it("leaves url null when baseUrl is omitted", async () => {
    const assignments = await fetchCourseAssignments(makeApiClient() as any, COURSE_ID);

    expect(assignments).toHaveLength(2);
    expect(assignments.every((a) => a.url === null)).toBe(true);
  });

  it("emits instructions as a plain markdown string, not {markdown, html}", async () => {
    const assignments = await fetchCourseAssignments(makeApiClient() as any, COURSE_ID);
    const [dropbox, quiz] = assignments;

    // Neither fixture supplies HTML instructions, so both fall back to "".
    expect(dropbox.instructions).toBe("");
    expect(quiz.instructions).toBe("");
  });
});

/**
 * The live Purdue tenant sends quiz rich text one level deeper than the flat
 * { Text, Html } this code assumed, calls the time limit SubmissionTimeLimit,
 * and answers /quizzes/{id}/attempts/ with 403 for every student. The mapping
 * has to read the shapes D2L actually sends and stop reporting an unmeasured
 * attempt count as if it were measured.
 */

/** Mocked client over a supplied quiz list, recording every requested path. */
function makeQuizClient(quizzes: any[], onAttempts: (quizId: number) => unknown) {
  const requested: string[] = [];
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      if (path.endsWith("/quizzes/")) return { Objects: quizzes };
      const attempts = path.match(/\/quizzes\/(\d+)\/attempts\/$/);
      if (attempts) return onAttempts(Number(attempts[1]));
      throw notFound();
    }),
  };
  return { apiClient, requested };
}

const quizzesOf = (assignments: any[]) => assignments.filter((a) => a.type === "quiz");

describe("fetchCourseAssignments quiz mapping", () => {
  it("recovers a visible quiz omitted from the quiz listing via the content table of contents", async () => {
    const requested: string[] = [];
    const apiClient = {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        requested.push(path);
        if (path.endsWith("/dropbox/folders/")) return [];
        if (path.endsWith("/quizzes/")) throw forbidden();
        if (path.endsWith("/grades/")) return [];
        if (path.endsWith("/content/toc")) {
          return {
            Modules: [{
              ModuleId: 10,
              Title: "Week 1",
              Modules: [],
              Topics: [{
                TopicId: 21916707,
                Title: "VNOS #1",
                ActivityType: 4,
                ToolItemId: 1408513,
                IsHidden: false,
                IsBroken: false,
                IsExempt: false,
              }],
            }],
          };
        }
        if (path.endsWith("/quizzes/1408513")) {
          return {
            QuizId: 1408513,
            Name: "VNOS #1",
            IsActive: true,
            DueDate: "2026-09-14T03:59:00.000Z",
          };
        }
        if (path.endsWith("/quizzes/1408513/attempts/")) throw forbidden();
        throw notFound();
      }),
    };

    const quizzes = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID, BASE));

    expect(quizzes).toHaveLength(1);
    expect(quizzes[0]).toMatchObject({
      id: 1408513,
      name: "VNOS #1",
      dueDate: "2026-09-14T03:59:00.000Z",
    });
    expect(requested).toContain(`/d2l/api/le/1.0/${COURSE_ID}/quizzes/1408513`);
  });

  it("does not refetch a content-linked quiz already present in the quiz listing", async () => {
    const { apiClient, requested } = makeQuizClient(
      [{ QuizId: 1408513, Name: "VNOS #1", IsActive: true }],
      () => {
        throw forbidden();
      }
    );
    apiClient.get.mockImplementation(async (path: string) => {
      requested.push(path);
      if (path.endsWith("/quizzes/")) {
        return { Objects: [{ QuizId: 1408513, Name: "VNOS #1", IsActive: true }] };
      }
      if (path.endsWith("/content/toc")) {
        return {
          Modules: [{
            Topics: [{ TopicId: 21916707, Title: "VNOS #1", ActivityType: 4, ToolItemId: 1408513 }],
          }],
        };
      }
      if (path.includes("/attempts/")) throw forbidden();
      throw notFound();
    });

    const quizzes = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quizzes).toHaveLength(1);
    expect(requested).not.toContain(`/d2l/api/le/1.0/${COURSE_ID}/quizzes/1408513`);
  });

  it("uses visible content metadata when the individual quiz route is unavailable", async () => {
    const apiClient = {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/dropbox/folders/")) return [];
        if (path.endsWith("/quizzes/")) return { Objects: [] };
        if (path.endsWith("/grades/")) return [];
        if (path.endsWith("/content/toc")) {
          return {
            Modules: [{
              Topics: [{ TopicId: 21916707, Title: "VNOS #1", ActivityType: 4, ToolItemId: 1408513 }],
            }],
          };
        }
        if (path.endsWith("/quizzes/1408513")) throw forbidden();
        if (path.endsWith("/content/topics/21916707")) {
          return {
            TopicId: 21916707,
            Title: "VNOS #1",
            DueDate: "2026-09-14T03:59:00.000Z",
          };
        }
        throw notFound();
      }),
    };

    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quiz).toMatchObject({
      id: 1408513,
      name: "VNOS #1",
      dueDate: "2026-09-14T03:59:00.000Z",
      attemptsAvailable: false,
    });
  });

  it("reads instructions from the nested Description the tenant sends", async () => {
    const { apiClient } = makeQuizClient(
      [
        {
          QuizId: 1,
          Name: "Quiz 1",
          IsActive: true,
          Description: {
            Text: { Text: "Read chapter 3", Html: "<p>Read <b>chapter 3</b></p>" },
            IsDisplayed: true,
          },
        },
      ],
      () => {
        throw notFound();
      }
    );

    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quiz.instructions).toContain("**chapter 3**");
  });

  it("still reads instructions from a flat Description", async () => {
    const { apiClient } = makeQuizClient(
      [
        {
          QuizId: 1,
          Name: "Quiz 1",
          IsActive: true,
          Description: { Text: "Read chapter 3", Html: "<p>Read <b>chapter 3</b></p>" },
        },
      ],
      () => {
        throw notFound();
      }
    );

    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quiz.instructions).toContain("**chapter 3**");
  });

  it("maps SubmissionTimeLimit onto timeLimit", async () => {
    const { apiClient } = makeQuizClient(
      [
        {
          QuizId: 1,
          Name: "Timed",
          IsActive: true,
          SubmissionTimeLimit: { IsEnforced: true, ShowClock: true, TimeLimitValue: 45 },
          SubmissionGracePeriod: 5,
          Password: "letmein",
        },
        {
          QuizId: 2,
          Name: "Untimed",
          IsActive: true,
          SubmissionTimeLimit: { IsEnforced: false, ShowClock: false, TimeLimitValue: 120 },
        },
      ],
      () => []
    );

    const [timed, untimed] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(timed.timeLimit).toBe(45);
    expect(timed.gracePeriodMinutes).toBe(5);
    expect(timed.hasPassword).toBe(true);
    expect(untimed.timeLimit).toBeNull();
    expect(untimed.gracePeriodMinutes).toBeNull();
    expect(untimed.hasPassword).toBe(false);
  });

  it("stops requesting attempts for a course after the first 403", async () => {
    const { apiClient, requested } = makeQuizClient(
      [
        { QuizId: 1, Name: "Quiz 1", IsActive: true, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 2 } },
        { QuizId: 2, Name: "Quiz 2", IsActive: true, AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 2 } },
      ],
      () => {
        throw forbidden();
      }
    );

    const quizzes = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    const attemptCalls = requested.filter((p) => p.includes("/attempts/"));
    expect(attemptCalls).toEqual([`/d2l/api/le/1.0/${COURSE_ID}/quizzes/1/attempts/`]);
    for (const quiz of quizzes) {
      expect(quiz.attemptsAvailable).toBe(false);
      expect(quiz.attemptsUsed).toBeNull();
      expect(quiz.attemptsRemaining).toBeNull();
      expect(quiz.bestScore).toBeNull();
      expect(quiz.attemptWarning).toBeNull();
    }
    // attemptsAllowed comes off the quiz object, so it survives the 403.
    expect(quizzes[0].attemptsAllowed).toBe(2);
  });

  it("keeps the attempt computation when the endpoint answers", async () => {
    const { apiClient } = makeQuizClient(
      [
        {
          QuizId: 1,
          Name: "Quiz 1",
          IsActive: true,
          AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 2 },
        },
      ],
      () => ({
        Objects: [
          { AttemptId: 9, AttemptNumber: 1, Score: 17, IsCompleted: true, CompletedDate: null },
        ],
      })
    );

    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quiz.attemptsAvailable).toBe(true);
    expect(quiz.attemptsUsed).toBe(1);
    expect(quiz.attemptsRemaining).toBe(1);
    expect(quiz.bestScore).toBe(17);
    expect(quiz.attemptWarning).toBe("WARNING: Only 1 attempt remaining");
  });
});

/**
 * The all-courses path reads the enrollment list itself. myenrollments is
 * bookmark-paged and its isActive filter is server-side, so the list has to be
 * followed to its last page and queried according to the configured
 * activeOnly policy — the same two rules get_my_courses already follows.
 */

import { registerGetAssignments } from "../../src/tools/get-assignments.js";
import type { AppConfig } from "../../src/types/index.js";

const COURSE_A = { Id: 101, Name: "CS 180", Code: "cs180" };
const COURSE_B = { Id: 202, Name: "MA 261", Code: "ma261" };

const enrollmentItem = (c: typeof COURSE_A, isActive = true) => ({
  OrgUnit: c,
  Access: { ClasslistRoleName: "Student", IsActive: isActive, LastAccessed: null },
});

function allCoursesConfig(activeOnly: boolean): AppConfig {
  return {
    baseUrl: BASE,
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly },
  } as AppConfig;
}

/** Registers the tool over a responder and records every requested path. */
function setupTool(respond: (path: string) => unknown, config: AppConfig) {
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

  registerGetAssignments(server as any, apiClient as any, config);
  return { call: (args: unknown) => handler!(args), requested };
}

/** One dropbox folder per course, named after it; everything else is empty. */
const courseWork = (path: string): unknown => {
  const match = path.match(/\/le\/1\.0\/(\d+)\/dropbox\/folders\/$/);
  if (match) {
    return [{ Id: Number(match[1]), Name: `HW ${match[1]}`, DueDate: null, IsHidden: false, GroupTypeId: null }];
  }
  if (path.endsWith("/quizzes/") || path.endsWith("/grades/")) return [];
  if (path.endsWith("/content/toc")) return { Modules: [] };
  throw notFound();
};

const body = (result: any) => JSON.parse(result.content[0].text);

describe("get_assignments across all courses", () => {
  it("follows the enrollment bookmark chain instead of stopping at page one", async () => {
    const { call, requested } = setupTool((path) => {
      if (path.includes("/enrollments/")) {
        return path.includes("bookmark=")
          ? { Items: [enrollmentItem(COURSE_B)], PagingInfo: { HasMoreItems: false } }
          : { Items: [enrollmentItem(COURSE_A)], PagingInfo: { HasMoreItems: true, Bookmark: "page-2" } };
      }
      return courseWork(path);
    }, allCoursesConfig(true));

    const { courses } = body(await call({}));
    expect(courses.map((c: any) => c.courseId)).toEqual([COURSE_A.Id, COURSE_B.Id]);
    expect(requested.filter((p) => p.includes("/enrollments/"))).toHaveLength(2);
  });

  it("drops isActive=true from the query when activeOnly is off", async () => {
    const { call, requested } = setupTool((path) => {
      if (path.includes("/enrollments/")) {
        // D2L filters server-side, so isActive=true really does hide COURSE_B.
        return {
          Items: path.includes("isActive=true")
            ? [enrollmentItem(COURSE_A)]
            : [enrollmentItem(COURSE_A), enrollmentItem(COURSE_B, false)],
        };
      }
      return courseWork(path);
    }, allCoursesConfig(false));

    const { courses } = body(await call({}));
    expect(requested[0]).not.toContain("isActive=true");
    expect(courses.map((c: any) => c.courseId)).toEqual([COURSE_A.Id, COURSE_B.Id]);
  });

  it("still asks only for active enrollments under the default policy", async () => {
    const { call, requested } = setupTool((path) => {
      if (path.includes("/enrollments/")) return { Items: [enrollmentItem(COURSE_A)] };
      return courseWork(path);
    }, allCoursesConfig(true));

    await call({});
    expect(requested[0]).toContain("isActive=true");
  });

  it("still returns the other courses when one course fails for a non-auth reason", async () => {
    const { call } = setupTool((path) => {
      if (path.includes("/enrollments/")) {
        return { Items: [enrollmentItem(COURSE_A), enrollmentItem(COURSE_B)] };
      }
      // A malformed dropbox payload makes this course's fetch throw a TypeError.
      if (path.endsWith(`/le/1.0/${COURSE_B.Id}/dropbox/folders/`)) return null;
      return courseWork(path);
    }, allCoursesConfig(true));

    const result = await call({});

    expect(result.isError).toBeUndefined();
    expect(body(result).courses.map((c: any) => c.courseId)).toEqual([COURSE_A.Id]);
  });
});

/**
 * A sign-in that has not finished is not an empty course. Every route below
 * get_assignments swallows its own failures so one forbidden endpoint cannot
 * hide the rest, but an authentication failure means none of them answered.
 * CLAUDE.md forbids turning a previously successful `{assignments: []}`
 * response into an error, so the tool keeps the success envelope and adds an
 * explicit authPending/notice pair a caller can check instead.
 */

import { AuthProcessError } from "../../src/auth/auth-runner.js";
import { ApiError } from "../../src/api/errors.js";

const mfaPending = () => new AuthProcessError("mfaPending", "MFA approval pending");

describe("get_assignments while sign-in is pending", () => {
  it("reports authPending for a single course instead of an empty list read as success", async () => {
    const { call } = setupTool(() => {
      throw mfaPending();
    }, allCoursesConfig(true));

    const result = await call({ courseId: COURSE_A.Id });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed).toMatchObject({ courseId: COURSE_A.Id, assignments: [], authPending: true });
    expect(parsed.notice).toContain("Approve the sign-in request");
  });

  it("reports authPending across all courses when the course routes cannot sign in", async () => {
    // Enrollments answer from cache, the course routes need a live session.
    const { call } = setupTool((path) => {
      if (path.includes("/enrollments/")) return { Items: [enrollmentItem(COURSE_A)] };
      throw mfaPending();
    }, allCoursesConfig(true));

    const result = await call({});

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.authPending).toBe(true);
    expect(parsed.unavailableCourseIds).toEqual([COURSE_A.Id]);
    expect(parsed.notice).toContain("Approve the sign-in request");
    expect(parsed.courses).toEqual([
      { courseId: COURSE_A.Id, courseName: COURSE_A.Name, assignments: [], authPending: true },
    ]);
  });

  it("reports authPending when only the dropbox route is rejected with 401", async () => {
    const { call } = setupTool((path) => {
      if (path.endsWith("/dropbox/folders/")) throw new ApiError(401, path, "expired");
      return courseWork(path);
    }, allCoursesConfig(true));

    const result = await call({ courseId: COURSE_A.Id });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed).toMatchObject({ courseId: COURSE_A.Id, assignments: [], authPending: true });
    expect(parsed.notice).toContain("Authentication expired");
  });

  it("reports authPending rather than reporting an assignment as unsubmitted", async () => {
    const { call } = setupTool((path) => {
      if (path.includes("/mysubmissions/")) throw mfaPending();
      return courseWork(path);
    }, allCoursesConfig(true));

    const result = await call({ courseId: COURSE_A.Id });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.authPending).toBe(true);
  });

  it("keeps the courses that answered when only one course's sign-in is pending", async () => {
    const { call } = setupTool((path) => {
      if (path.includes("/enrollments/")) {
        return { Items: [enrollmentItem(COURSE_A), enrollmentItem(COURSE_B)] };
      }
      if (path.includes(`/le/1.0/${COURSE_B.Id}/`)) throw mfaPending();
      return courseWork(path);
    }, allCoursesConfig(true));

    const result = await call({});

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.authPending).toBe(true);
    expect(parsed.unavailableCourseIds).toEqual([COURSE_B.Id]);

    const answered = parsed.courses.find((c: any) => c.courseId === COURSE_A.Id);
    expect(answered.assignments).toHaveLength(1);
    expect(answered.authPending).toBeUndefined();

    const pending = parsed.courses.find((c: any) => c.courseId === COURSE_B.Id);
    expect(pending).toEqual({ courseId: COURSE_B.Id, courseName: COURSE_B.Name, assignments: [], authPending: true });
  });
});

/**
 * submissionStatus and attemptStatus are additive fields that tell "known to
 * be unsubmitted/unattempted" (a 404, D2L's own way of saying "nothing yet")
 * apart from "the tenant denied the lookup" (any other error), so a denied
 * 403 is never reported to the user as missing work.
 */
describe("fetchCourseAssignments submissionStatus", () => {
  function makeSubmissionClient(mysubmissionsBehavior: () => unknown) {
    return {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/dropbox/folders/")) {
          return [{ Id: 55, Name: "HW 1", DueDate: null, IsHidden: false, GroupTypeId: null }];
        }
        if (path.includes("/mysubmissions/")) return mysubmissionsBehavior();
        if (path.endsWith("/quizzes/") || path.endsWith("/grades/")) return [];
        if (path.endsWith("/content/toc")) return { Modules: [] };
        throw notFound();
      }),
    };
  }

  it("reports submitted when the submissions list has rows", async () => {
    const apiClient = makeSubmissionClient(() => [
      {
        Id: 1,
        SubmittedBy: { Identifier: "u1", DisplayName: "Student" },
        SubmissionDate: "2026-09-01T00:00:00Z",
        Comment: null,
        Files: [],
      },
    ]);
    const [assignment] = await fetchCourseAssignments(apiClient as any, COURSE_ID);

    expect(assignment.submissionStatus).toBe("submitted");
    expect(assignment.submissionStatusNote).toBeUndefined();
  });

  it("reports not_submitted on a 404 - D2L's own way of saying nothing was turned in", async () => {
    const apiClient = makeSubmissionClient(() => {
      throw notFound();
    });
    const [assignment] = await fetchCourseAssignments(apiClient as any, COURSE_ID);

    expect(assignment.submissionStatus).toBe("not_submitted");
    expect(assignment.submission).toBeNull();
    expect(assignment.submissionStatusNote).toBeUndefined();
  });

  it("reports unknown, not not_submitted, when the tenant denies the submission list with 403", async () => {
    const apiClient = makeSubmissionClient(() => {
      throw forbidden();
    });
    const [assignment] = await fetchCourseAssignments(apiClient as any, COURSE_ID);

    expect(assignment.submissionStatus).toBe("unknown");
    expect(assignment.submission).toBeNull();
    expect(assignment.submissionStatusNote).toMatch(/did not return this assignment's submission list/);
  });
});

describe("fetchCourseAssignments attemptStatus", () => {
  it("marks attempts unknown, not zero, when the tenant denies the attempts endpoint with 403", async () => {
    const { apiClient } = makeQuizClient(
      [
        {
          QuizId: 1,
          Name: "Quiz 1",
          IsActive: true,
          AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 2 },
        },
      ],
      () => {
        throw forbidden();
      }
    );
    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quiz.attemptStatus).toBe("unknown");
    expect(quiz.attemptsUsed).toBeNull();
    expect(quiz.attemptStatusNote).toMatch(/did not provide this quiz's attempt data/);
  });

  it("marks attempts known once the endpoint answers, even with zero completed attempts", async () => {
    const { apiClient } = makeQuizClient([{ QuizId: 1, Name: "Quiz 1", IsActive: true }], () => []);
    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));

    expect(quiz.attemptStatus).toBe("known");
    expect(quiz.attemptsUsed).toBe(0);
    expect(quiz.attemptStatusNote).toBeUndefined();
  });
});

/**
 * dueIn is additive: a relative-time rendering of dueDate so a caller doesn't
 * have to do its own date math. It rides next to dueDate wherever that field
 * already appears, and is null wherever dueDate is null (gradeOnly rows).
 */
describe("fetchCourseAssignments dueIn", () => {
  const NOW = new Date("2026-09-02T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds a relative dueIn next to a dropbox folder's dueDate, leaving dueDate unchanged", async () => {
    const dueDate = "2026-09-05T12:00:00.000Z"; // 3 days out
    const apiClient = {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/dropbox/folders/")) {
          return [{ Id: 55, Name: "HW 1", DueDate: dueDate, IsHidden: false, GroupTypeId: null }];
        }
        if (path.endsWith("/quizzes/")) return { Objects: [] };
        if (path.endsWith("/grades/")) return [];
        if (path.endsWith("/content/toc")) return { Modules: [] };
        throw notFound();
      }),
    };

    const [assignment] = await fetchCourseAssignments(apiClient as any, COURSE_ID, BASE);
    expect(assignment.dueDate).toBe(dueDate);
    expect(assignment.dueIn).toBe("in 3 days");
  });

  it("adds a relative dueIn next to a quiz's dueDate, leaving dueDate unchanged", async () => {
    const dueDate = "2026-09-01T12:00:00.000Z"; // 1 day in the past
    const { apiClient } = makeQuizClient(
      [{ QuizId: 66, Name: "Quiz 1", IsActive: true, DueDate: dueDate }],
      () => []
    );

    const [quiz] = quizzesOf(await fetchCourseAssignments(apiClient as any, COURSE_ID));
    expect(quiz.dueDate).toBe(dueDate);
    expect(quiz.dueIn).toBe("yesterday");
  });

  it("keeps dueIn null for a gradeOnly row, same as its always-null dueDate", async () => {
    const apiClient = {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/dropbox/folders/")) return [];
        if (path.endsWith("/quizzes/")) return { Objects: [] };
        if (path.endsWith("/content/toc")) return { Modules: [] };
        if (path.endsWith("/grades/")) {
          return [{ Id: 9, Name: "Proctored Exam", GradeObjectTypeId: 1, AssociatedTool: null }];
        }
        throw notFound();
      }),
    };

    const [row] = await fetchCourseAssignments(apiClient as any, COURSE_ID, BASE);
    expect(row.type).toBe("gradeOnly");
    expect(row.dueDate).toBeNull();
    expect(row.dueIn).toBeNull();
  });
});

/**
 * Adapted from LunaParker/brightspace-mcp-server (MIT): a dropbox folder can
 * carry instructor-provided URL links (D2L's `LinkAttachments`) alongside its
 * file attachments. Surfaced as an additive `linkAttachments: [{ name, url }]`
 * array; omitted entirely (not an empty array) when the folder has none, so
 * the existing assignment shape is untouched for every folder that doesn't
 * use this D2L feature.
 */
describe("fetchCourseAssignments link attachments", () => {
  function makeDropboxClient(folder: Record<string, unknown>) {
    return {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/dropbox/folders/")) return [folder];
        if (path.endsWith("/quizzes/")) return { Objects: [] };
        if (path.endsWith("/grades/")) return [];
        if (path.endsWith("/content/toc")) return { Modules: [] };
        throw notFound();
      }),
    };
  }

  it("maps two link attachments to name/url", async () => {
    const apiClient = makeDropboxClient({
      Id: 55,
      Name: "HW 1",
      DueDate: null,
      IsHidden: false,
      GroupTypeId: null,
      LinkAttachments: [
        { LinkId: 1, Title: "Project spec", Href: "https://example.com/spec.pdf" },
        { LinkId: 2, Title: "Starter repo", Href: "https://example.com/repo" },
      ],
    });

    const [assignment] = await fetchCourseAssignments(apiClient as any, COURSE_ID);

    expect(assignment.linkAttachments).toEqual([
      { name: "Project spec", url: "https://example.com/spec.pdf" },
      { name: "Starter repo", url: "https://example.com/repo" },
    ]);
  });

  it("omits linkAttachments entirely for a folder with none", async () => {
    const apiClient = makeDropboxClient({
      Id: 55,
      Name: "HW 1",
      DueDate: null,
      IsHidden: false,
      GroupTypeId: null,
    });

    const [assignment] = await fetchCourseAssignments(apiClient as any, COURSE_ID);

    expect(assignment).not.toHaveProperty("linkAttachments");
  });

  it("prefers LinkName over Title, D2L's documented field for the link's display text", async () => {
    const apiClient = makeDropboxClient({
      Id: 55,
      Name: "HW 1",
      DueDate: null,
      IsHidden: false,
      GroupTypeId: null,
      LinkAttachments: [
        { LinkId: 1, LinkName: "Project spec", Title: "Ignored title", Href: "https://example.com/spec.pdf" },
        { LinkId: 2, LinkName: "Starter repo", Href: "https://example.com/repo" },
      ],
    });

    const [assignment] = await fetchCourseAssignments(apiClient as any, COURSE_ID);

    expect(assignment.linkAttachments).toEqual([
      { name: "Project spec", url: "https://example.com/spec.pdf" },
      { name: "Starter repo", url: "https://example.com/repo" },
    ]);
  });

  it("drops a link entry with no Href rather than emitting a null url", async () => {
    const apiClient = makeDropboxClient({
      Id: 55,
      Name: "HW 1",
      DueDate: null,
      IsHidden: false,
      GroupTypeId: null,
      LinkAttachments: [{ LinkId: 1, Title: "Broken link" }],
    });

    const [assignment] = await fetchCourseAssignments(apiClient as any, COURSE_ID);

    expect(assignment).not.toHaveProperty("linkAttachments");
  });
});
