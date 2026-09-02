import { describe, it, expect, vi } from "vitest";
import { fetchCourseAssignments } from "../../src/tools/get-assignments.js";

/**
 * Gradebook heads-up rows.
 *
 * A course's gradebook carries columns for work that the student's own
 * dropbox and quiz listings cannot see: a proctored midterm, a participation
 * score, an exam administered outside Brightspace. Those columns are the only
 * evidence such work exists, so they are surfaced as items of their own.
 *
 * Two rules decide which columns qualify:
 *   1. Student-scored types only (1 numeric, 2 passfail, 3 selectbox, 4 text).
 *      The bookkeeping types (category, calculated, formula, final) describe
 *      the gradebook's own arithmetic, not work anybody owes.
 *   2. The column must match no already-fetched assignment or quiz, compared
 *      on AssociatedTool.ToolItemId. A linked column whose tool item WAS
 *      fetched is a duplicate; a linked column whose tool item was not is
 *      exactly the case this exists for.
 */

const BASE = "https://brightspace.example.edu";
const COURSE_ID = 101;

const FOLDER = { Id: 55, Name: "HW 1", DueDate: null, IsHidden: false, GroupTypeId: null };
const QUIZ = { QuizId: 66, Name: "Quiz 1", IsActive: true };

/**
 * @param columns the gradebook payload, a bare array in D2L's own shape
 */
function makeApiClient(columns: unknown) {
  return {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/dropbox/folders/")) return [FOLDER];
      if (path.endsWith("/quizzes/")) return { Objects: [QUIZ] };
      if (path.endsWith("/grades/")) {
        if (columns instanceof Error) throw columns;
        return columns;
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }),
  };
}

const headsUp = (items: any[]) => items.filter((i) => i.type === "gradeOnly");

describe("gradebook heads-up rows", () => {
  it("surfaces a student-scored column that matches no fetched item", async () => {
    const items = await fetchCourseAssignments(
      makeApiClient([
        { Id: 900, Name: "Midterm Exam", GradeObjectTypeId: 1, AssociatedTool: null },
      ]) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items)).toEqual([
      {
        type: "gradeOnly",
        id: 900,
        name: "Midterm Exam",
        dueDate: null,
        url: `${BASE}/d2l/lms/grades/my_grades/main.d2l?ou=${COURSE_ID}`,
      },
    ]);
  });

  it("drops a column already covered by a fetched quiz or assignment", async () => {
    const items = await fetchCourseAssignments(
      makeApiClient([
        { Id: 901, Name: "Quiz 1", GradeObjectTypeId: 1, AssociatedTool: { ToolItemId: 66 } },
        { Id: 902, Name: "HW 1", GradeObjectTypeId: 1, AssociatedTool: { ToolItemId: 55 } },
      ]) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items)).toEqual([]);
  });

  it("keeps a linked column whose tool item was never fetched", async () => {
    // The whole point: a released midterm's column IS linked, to a quiz the
    // student's own quizzes/ call cannot see.
    const items = await fetchCourseAssignments(
      makeApiClient([
        { Id: 903, Name: "Proctored Final", GradeObjectTypeId: 1, AssociatedTool: { ToolItemId: 7777 } },
      ]) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items).map((i) => i.name)).toEqual(["Proctored Final"]);
  });

  it("keeps every student-scored type and no bookkeeping type", async () => {
    const items = await fetchCourseAssignments(
      makeApiClient([
        { Id: 1, Name: "numeric", GradeObjectTypeId: 1 },
        { Id: 2, Name: "passfail", GradeObjectTypeId: 2 },
        { Id: 3, Name: "selectbox", GradeObjectTypeId: 3 },
        { Id: 4, Name: "text", GradeObjectTypeId: 4 },
        { Id: 5, Name: "category", GradeObjectTypeId: 5 },
        { Id: 6, Name: "calculated", GradeObjectTypeId: 6 },
        { Id: 7, Name: "formula", GradeObjectTypeId: 7 },
        { Id: 8, Name: "final", GradeObjectTypeId: 8 },
      ]) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items).map((i) => i.name)).toEqual([
      "numeric",
      "passfail",
      "selectbox",
      "text",
    ]);
  });

  it("skips a nameless or id-less column without losing its siblings", async () => {
    const items = await fetchCourseAssignments(
      makeApiClient([
        { Name: "no id", GradeObjectTypeId: 1 },
        { Id: 905, GradeObjectTypeId: 1 },
        { Id: 906, Name: "Attendance", GradeObjectTypeId: 2 },
      ]) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items).map((i) => i.name)).toEqual(["Attendance"]);
  });

  it("carries a null url when no baseUrl was supplied", async () => {
    const items = await fetchCourseAssignments(
      makeApiClient([{ Id: 907, Name: "Participation", GradeObjectTypeId: 1 }]) as any,
      COURSE_ID
    );

    expect(headsUp(items)[0].url).toBeNull();
  });

  it("a failing gradebook costs only its own rows", async () => {
    const items = await fetchCourseAssignments(
      makeApiClient(Object.assign(new Error("Forbidden"), { status: 403 })) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items)).toEqual([]);
    // The assignments and quizzes that did answer are untouched.
    expect(items.map((i) => i.type)).toEqual(["assignment", "quiz"]);
  });

  it("tolerates a gradebook that is not an array", async () => {
    const items = await fetchCourseAssignments(
      makeApiClient({ Objects: "not a list" }) as any,
      COURSE_ID,
      BASE
    );

    expect(headsUp(items)).toEqual([]);
    expect(items).toHaveLength(2);
  });
});
