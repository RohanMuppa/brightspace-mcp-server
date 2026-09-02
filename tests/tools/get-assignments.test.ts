import { describe, it, expect, vi } from "vitest";
import { fetchCourseAssignments } from "../../src/tools/get-assignments.js";

/**
 * fetchCourseAssignments takes baseUrl as an optional trailing argument so the
 * dropbox and quiz results can carry a deep link back into Brightspace.
 */

const BASE = "https://brightspace.example.edu";
const COURSE_ID = 101;

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
      throw Object.assign(new Error("Not Found"), { status: 404 });
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
