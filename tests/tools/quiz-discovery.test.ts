import { describe, it, expect, vi } from "vitest";
import { registerGetAssignments } from "../../src/tools/get-assignments.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Quiz discovery.
 *
 * Two outside reports showed get_assignments omitting quizzes even though every
 * request succeeded: a quiz visible in get_course_content (with its access
 * window) and a quiz in the gradebook were both missing. The causes covered
 * here, each with D2L-shaped payloads:
 *
 *  - /content/toc hides date-restricted modules and topics (a quiz whose access
 *    window has closed or not opened) unless ignoreDateRestrictions=true.
 *  - a quiz row that omits IsActive was treated as inactive.
 *  - a quiz topic whose ToolItemId is null was dropped, though its Url or its
 *    title still identifies it.
 *  - a topic marked IsExempt (exempt from grading) was dropped, though the quiz
 *    can still be taken.
 *  - a gradebook column linked to a quiz the list omits was only a bare row.
 */

const BASE = "https://brightspace.example.edu";
const COURSE = { Id: 101, Name: "CS 180", Code: "cs180" };
const LE = `/d2l/api/le/1.0/${COURSE.Id}`;

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
const forbidden = () => Object.assign(new Error("Forbidden"), { status: 403 });
const badRequest = () => Object.assign(new Error("Bad Request"), { status: 400 });

const config = {
  baseUrl: BASE,
  sessionDir: "/tmp/nope",
  tokenTtl: 3600,
  headless: true,
  courseFilter: { activeOnly: true },
} as AppConfig;

const TOC_ALL_DATES = `${LE}/content/toc?ignoreDateRestrictions=true&ignoreModuleDateRestrictions=true`;
const TOC_PLAIN = `${LE}/content/toc`;

/** Exact-path responses; a value that is a function is called, and may throw. */
type Routes = Record<string, unknown | (() => unknown)>;

function setupTool(routes: Routes) {
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
      if (!(path in routes)) throw notFound();
      const route = routes[path];
      return typeof route === "function" ? (route as () => unknown)() : route;
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };
  registerGetAssignments(server as any, apiClient as any, config);
  const call = (args: unknown) => handler!(args).then((r: any) => JSON.parse(r.content[0].text));
  return { call, requested };
}

const quizzesOf = (result: any) => result.assignments.filter((a: any) => a.type === "quiz");

/** A quiz topic as /content/toc sends it (ContentTableOfContents Topic). */
const quizTopic = (over: Record<string, unknown> = {}) => ({
  TopicId: 5001,
  Identifier: "5001",
  TypeIdentifier: "Quiz",
  Title: "Quiz 3",
  Url: `/d2l/common/dialogs/quickLink/quickLink.d2l?ou=${COURSE.Id}&type=quiz&rcode=ABC-1408600`,
  ActivityId: null,
  ToolId: 2000,
  ToolItemId: 1408600,
  ActivityType: 4,
  IsHidden: false,
  IsLocked: false,
  IsBroken: false,
  IsExempt: false,
  StartDateTime: "2026-09-01T04:00:00.000Z",
  EndDateTime: "2026-09-08T03:59:00.000Z",
  ...over,
});

const tocOf = (...topics: unknown[]) => ({
  Modules: [{ ModuleId: 1, Title: "Unit 1", Modules: [], Topics: topics }],
});

describe("get_assignments quiz discovery: date-restricted content", () => {
  it("asks the table of contents to include date-restricted items", async () => {
    const { call, requested } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(),
    });

    await call({ courseId: COURSE.Id });

    expect(requested).toContain(TOC_ALL_DATES);
  });

  it("lists a quiz whose access window closed, which the default table of contents hides", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [{ QuizId: 1, Name: "Quiz 1", IsActive: true }] },
      [`${LE}/grades/`]: [],
      [TOC_PLAIN]: tocOf(),
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: {
        QuizId: 1408600,
        Name: "Quiz 3",
        IsActive: true,
        StartDate: "2026-09-01T04:00:00.000Z",
        EndDate: "2026-09-08T03:59:00.000Z",
        DueDate: "2026-09-08T03:59:00.000Z",
      },
    });

    const result = await call({ courseId: COURSE.Id });

    expect(quizzesOf(result).map((q: any) => q.name)).toEqual(["Quiz 1", "Quiz 3"]);
    expect(result.quizCoverage).toBe("complete");
  });

  it("recovers a quiz from a module nested inside another module", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: {
        Modules: [{
          ModuleId: 1,
          Title: "Unit 1",
          Topics: [],
          Modules: [{ ModuleId: 2, Title: "Week 2", Topics: [], Modules: [{ ModuleId: 3, Title: "Exams", Topics: [quizTopic()] }] }],
        }],
      },
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
    });

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => q.id)).toEqual([1408600]);
  });

  it("falls back to the default table of contents and says date-hidden quizzes may be missing", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: () => { throw badRequest(); },
      [TOC_PLAIN]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
    });

    const result = await call({ courseId: COURSE.Id });

    expect(quizzesOf(result).map((q: any) => q.name)).toEqual(["Quiz 3"]);
    expect(result.quizCoverage).toBe("incomplete");
    expect(result.quizCoverageNote).toMatch(/date/i);
  });

  it("marks a quiz found only in date-restricted content with its source and window", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: () => { throw forbidden(); },
      [`${LE}/content/topics/5001`]: quizTopic(),
    });

    const [quiz] = quizzesOf(await call({ courseId: COURSE.Id }));

    expect(quiz).toMatchObject({
      id: 1408600,
      name: "Quiz 3",
      source: "courseContent",
      startDate: "2026-09-01T04:00:00.000Z",
      endDate: "2026-09-08T03:59:00.000Z",
      attemptStatus: "unknown",
    });
  });
});

describe("get_assignments quiz discovery: the quiz list", () => {
  it("keeps a listed quiz whose row omits IsActive", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [{ QuizId: 7, Name: "Quiz 7" }] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(),
    });

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => q.name)).toEqual(["Quiz 7"]);
  });

  it("still skips a quiz the instructor marked inactive", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [{ QuizId: 7, Name: "Quiz 7", IsActive: false }] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(),
    });

    expect(quizzesOf(await call({ courseId: COURSE.Id }))).toEqual([]);
  });

  it("does not drop a quiz because its window has closed", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: {
        Objects: [{ QuizId: 8, Name: "Quiz 8", IsActive: true, StartDate: "2020-01-01T00:00:00.000Z", EndDate: "2020-01-08T00:00:00.000Z" }],
      },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(),
    });

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => q.name)).toEqual(["Quiz 8"]);
  });

  it("labels a listed quiz with its source", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [{ QuizId: 7, Name: "Quiz 7", IsActive: true }] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(),
    });

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0].source).toBe("quizList");
  });
});

describe("get_assignments quiz discovery: content topic shapes", () => {
  it("reads the quiz id from the topic's quiz_summary Url when ToolItemId is null", async () => {
    const { call, requested } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(quizTopic({
        ToolId: null,
        ToolItemId: null,
        TypeIdentifier: "Link",
        ActivityType: 2,
        Url: `/d2l/lms/quizzing/user/quiz_summary.d2l?qi=1408700&ou=${COURSE.Id}`,
      })),
      [`${LE}/quizzes/1408700`]: { QuizId: 1408700, Name: "Quiz 4", IsActive: true },
    });

    const result = await call({ courseId: COURSE.Id });

    expect(quizzesOf(result).map((q: any) => q.id)).toEqual([1408700]);
    expect(requested).toContain(`${LE}/quizzes/1408700`);
  });

  it("lists a quiz topic with no resolvable id as a content entry instead of dropping it", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(quizTopic({ ToolId: null, ToolItemId: null })),
    });

    const result = await call({ courseId: COURSE.Id });

    expect(quizzesOf(result)).toHaveLength(1);
    expect(quizzesOf(result)[0]).toMatchObject({
      type: "quiz",
      id: null,
      topicId: 5001,
      name: "Quiz 3",
      source: "courseContent",
      endDate: "2026-09-08T03:59:00.000Z",
      attemptStatus: "unknown",
      url: `${BASE}/d2l/le/content/${COURSE.Id}/viewContent/5001/View`,
    });
  });

  it("does not repeat a listed quiz when its content topic has no id but the same title", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [{ QuizId: 9, Name: "Quiz 3", IsActive: true }] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(quizTopic({ ToolId: null, ToolItemId: null, Title: "  quiz   3 " })),
    });

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => q.id)).toEqual([9]);
  });

  it("lists a quiz topic exempt from grading, which can still be taken", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(quizTopic({ IsExempt: true })),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Practice Quiz", IsActive: true },
    });

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => q.name)).toEqual(["Practice Quiz"]);
  });

  it("still skips a hidden quiz topic and a broken one", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [],
      [TOC_ALL_DATES]: tocOf(quizTopic({ IsHidden: true }), quizTopic({ TopicId: 5002, ToolItemId: 1408601, IsBroken: true })),
    });

    expect(quizzesOf(await call({ courseId: COURSE.Id }))).toEqual([]);
  });
});

describe("get_assignments quiz discovery: gradebook columns", () => {
  const column = (over: Record<string, unknown> = {}) => ({
    Id: 900,
    Name: "Quiz 2",
    GradeObjectTypeId: 1,
    AssociatedTool: { ToolId: 2000, ToolItemId: 1408550 },
    ...over,
  });

  it("turns a gradebook column linked to an unlisted quiz into a full quiz entry", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [column()],
      [TOC_ALL_DATES]: tocOf(),
      [`${LE}/quizzes/1408550`]: {
        QuizId: 1408550,
        Name: "Quiz 2",
        IsActive: true,
        GradeItemId: 900,
        EndDate: "2026-09-20T03:59:00.000Z",
      },
    });

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.name])).toEqual([["quiz", "Quiz 2"]]);
    expect(quizzesOf(result)[0]).toMatchObject({
      id: 1408550,
      source: "gradebook",
      endDate: "2026-09-20T03:59:00.000Z",
      url: `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=1408550&ou=${COURSE.Id}`,
    });
  });

  it("does not attach a readable quiz that belongs to a different grade item", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [column()],
      [TOC_ALL_DATES]: tocOf(),
      [`${LE}/quizzes/1408550`]: { QuizId: 1408550, Name: "Unrelated", IsActive: true, GradeItemId: 12345 },
    });

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.name])).toEqual([["gradeOnly", "Quiz 2"]]);
  });

  it("keeps the bare gradebook row when the quiz cannot be read", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [column()],
      [TOC_ALL_DATES]: tocOf(),
      [`${LE}/quizzes/1408550`]: () => { throw forbidden(); },
    });

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.name])).toEqual([["gradeOnly", "Quiz 2"]]);
  });

  it("does not probe quiz routes for a column linked to a dropbox folder", async () => {
    const { call, requested } = setupTool({
      [`${LE}/dropbox/folders/`]: [{ Id: 55, Name: "HW 1", DueDate: null, IsHidden: false, GroupTypeId: null }],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [column({ Id: 901, Name: "HW 1", AssociatedTool: { ToolId: 1000, ToolItemId: 55 } })],
      [TOC_ALL_DATES]: tocOf(),
    });

    await call({ courseId: COURSE.Id });

    expect(requested.filter((p) => p.includes("/quizzes/55"))).toEqual([]);
  });

  it("does not probe columns whose tool is one already seen on a dropbox folder", async () => {
    const { call, requested } = setupTool({
      [`${LE}/dropbox/folders/`]: [{ Id: 55, Name: "HW 1", DueDate: null, IsHidden: false, GroupTypeId: null }],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [
        column({ Id: 901, Name: "HW 1", AssociatedTool: { ToolId: 1000, ToolItemId: 55 } }),
        column({ Id: 902, Name: "HW 2", AssociatedTool: { ToolId: 1000, ToolItemId: 56 } }),
      ],
      [TOC_ALL_DATES]: tocOf(),
    });

    await call({ courseId: COURSE.Id });

    expect(requested.filter((p) => p.includes("/quizzes/56"))).toEqual([]);
  });

  it("does not turn calculated columns into quizzes", async () => {
    const { call, requested } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [column({ GradeObjectTypeId: 5 })],
      [TOC_ALL_DATES]: tocOf(),
    });

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments).toEqual([]);
    expect(requested.filter((p) => p.includes("/quizzes/1408550"))).toEqual([]);
  });

  it("does not repeat a gradebook-linked quiz the content already recovered", async () => {
    const { call } = setupTool({
      [`${LE}/dropbox/folders/`]: [],
      [`${LE}/quizzes/`]: { Objects: [] },
      [`${LE}/grades/`]: [column({ AssociatedTool: { ToolId: 2000, ToolItemId: 1408600 } })],
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true, GradeItemId: 900 },
    });

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.id])).toEqual([["quiz", 1408600]]);
  });
});
