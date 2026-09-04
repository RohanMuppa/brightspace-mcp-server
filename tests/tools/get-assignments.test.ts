import { describe, it, expect, vi } from "vitest";
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

    expect(quiz.instructions.markdown).toContain("**chapter 3**");
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

    expect(quiz.instructions.markdown).toContain("**chapter 3**");
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
