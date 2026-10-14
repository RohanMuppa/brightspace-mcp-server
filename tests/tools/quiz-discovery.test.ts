import { describe, it, expect, vi, afterEach } from "vitest";
import { registerGetAssignments } from "../../src/tools/get-assignments.js";
import { ApiError } from "../../src/api/errors.js";
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
const serverError = () => Object.assign(new Error("Server Error"), { status: 500 });

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

/** A course with nothing in it; spread overrides on top. */
const base = (over: Routes = {}): Routes => ({
  [`${LE}/dropbox/folders/`]: [],
  [`${LE}/quizzes/`]: { Objects: [] },
  [`${LE}/grades/`]: [],
  [TOC_ALL_DATES]: tocOf(),
  ...over,
});

const plainUrl = `/d2l/common/dialogs/quickLink/quickLink.d2l?ou=${COURSE.Id}&rcode=ABC`;

/** A topic that names no quiz id anywhere (D2L sometimes sends it so). */
const idlessTopic = (over: Record<string, unknown> = {}) =>
  quizTopic({ ToolId: null, ToolItemId: null, ...over });

/**
 * A gradebook column as D2L documents it: GradeType is a string and there is no
 * GradeObjectTypeId (GradeObject block, grade.html).
 */
const gcol = (over: Record<string, unknown> = {}) => ({
  Id: 900,
  Name: "Quiz 2",
  GradeType: "Numeric",
  AssociatedTool: { ToolId: 2000, ToolItemId: 1408550 },
  ...over,
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

describe("get_assignments quiz discovery: how quiz topics are recognized", () => {
  it.each([
    ["TypeIdentifier alone", { TypeIdentifier: "Quiz", ActivityType: 0, Url: plainUrl }],
    ["ActivityType 4 alone", { TypeIdentifier: "Link", ActivityType: 4, Url: plainUrl }],
    ["quickLink type=quiz alone", { TypeIdentifier: "Link", ActivityType: 2, Url: `${plainUrl}&type=quiz` }],
    [
      "entity-encoded &amp;type=quiz alone",
      { TypeIdentifier: "Link", ActivityType: 2, Url: `/d2l/common/dialogs/quickLink/quickLink.d2l?ou=${COURSE.Id}&amp;type=quiz&amp;rcode=ABC` },
    ],
    [
      "quiz_* Url alone (ToolItemId set)",
      { TypeIdentifier: "Link", ActivityType: 2, Url: `/d2l/lms/quizzing/user/quiz_summary.d2l?qi=1408600&ou=${COURSE.Id}` },
    ],
  ])("recognizes a quiz topic by %s", async (_label, over) => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic(over)),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => q.id)).toEqual([1408600]);
  });

  it("does not take an ordinary link topic for a quiz", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic({ TypeIdentifier: "Link", ActivityType: 2, Url: plainUrl })),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))).toEqual([]);
  });

  it("reads the quiz id from ActivityId when ToolItemId and the Url carry none", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic({ ToolItemId: null, ActivityId: "1408600", Url: `${plainUrl}&type=quiz` })),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => q.id)).toEqual([1408600]);
  });

  it("labels a content quiz fetched by id with source courseContent", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0].source).toBe("courseContent");
  });

  it("lists a quiz once when two modules link to it", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: { Modules: [
        { ModuleId: 1, Title: "A", Modules: [], Topics: [quizTopic()] },
        { ModuleId: 2, Title: "B", Modules: [], Topics: [quizTopic({ TopicId: 5099 })] },
      ] },
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => q.id)).toEqual([1408600]);
  });

  it("returns only the documented keys per course when listing every course", async () => {
    const { call } = setupTool(base());

    const { courses } = await call({});

    expect(Object.keys(courses[0]).sort()).toEqual(["assignments", "courseId", "courseName", "quizCoverage"]);
  });
});

describe("get_assignments quiz discovery: id-less content quizzes", () => {
  it("lists two different id-less quiz topics separately", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(
        idlessTopic({ TopicId: 5001, Title: "Quiz A", Url: `${plainUrl}&type=quiz&a=1` }),
        idlessTopic({ TopicId: 5002, Title: "Quiz B", Url: `${plainUrl}&type=quiz&a=2` })
      ),
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => [q.topicId, q.name]))
      .toEqual([[5001, "Quiz A"], [5002, "Quiz B"]]);
  });

  it("lists an id-less quiz linked from two modules once", async () => {
    const link = `${plainUrl}&type=quiz&rcode=SHARED`;
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: { Modules: [
        { ModuleId: 1, Title: "Unit 1", Modules: [], Topics: [idlessTopic({ TopicId: 5001, Title: "Quiz 3", Url: link })] },
        { ModuleId: 2, Title: "Review", Modules: [], Topics: [idlessTopic({ TopicId: 5099, Title: " QUIZ  3 ", Url: link })] },
      ] },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))).toHaveLength(1);
  });

  it("keeps two id-less topics apart when only their titles match", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(
        idlessTopic({ TopicId: 5001, Title: "Quiz", Url: `${plainUrl}&type=quiz&rcode=ONE` }),
        idlessTopic({ TopicId: 5002, Title: "Quiz", Url: `${plainUrl}&type=quiz&rcode=TWO` })
      ),
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => q.topicId)).toEqual([5001, 5002]);
  });

  it("adopts the quiz id of the gradebook column a topic's GradeItemId names, and lists the quiz once", async () => {
    const { call, requested } = setupTool(base({
      [`${LE}/grades/`]: [gcol()],
      [TOC_ALL_DATES]: tocOf(idlessTopic({ GradeItemId: 900 })),
      [`${LE}/quizzes/1408550`]: { QuizId: 1408550, Name: "Quiz 3", IsActive: true, GradeItemId: 900 },
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.id, a.source])).toEqual([["quiz", 1408550, "courseContent"]]);
    expect(requested.filter((p) => p.endsWith("/quizzes/1408550"))).toHaveLength(1);
  });

  it("lists one row, not a duplicate gradeOnly row, when the adopted quiz cannot be read", async () => {
    const { call } = setupTool(base({
      [`${LE}/grades/`]: [gcol()],
      [TOC_ALL_DATES]: tocOf(idlessTopic({ GradeItemId: 900 })),
      [`${LE}/quizzes/1408550`]: () => { throw forbidden(); },
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.id, a.name])).toEqual([["quiz", 1408550, "Quiz 3"]]);
    expect(result.assignments[0].detailsStatus).toBe("unavailable");
  });

  it("adds nothing when the adopted quiz id is already in the quiz list", async () => {
    const { call } = setupTool(base({
      [`${LE}/quizzes/`]: { Objects: [{ QuizId: 1408550, Name: "Quiz 3", IsActive: true }] },
      [`${LE}/grades/`]: [gcol()],
      [TOC_ALL_DATES]: tocOf(idlessTopic({ GradeItemId: 900 })),
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.id, a.source])).toEqual([["quiz", 1408550, "quizList"]]);
  });

  it("does not adopt a column that belongs to a different tool than the topic", async () => {
    const { call } = setupTool(base({
      [`${LE}/grades/`]: [gcol({ AssociatedTool: { ToolId: 3000, ToolItemId: 77 } })],
      [TOC_ALL_DATES]: tocOf(idlessTopic({ ToolId: 2000, GradeItemId: 900 })),
    }));

    const [quiz] = quizzesOf(await call({ courseId: COURSE.Id }));

    expect(quiz.id).toBeNull();
  });

  it("does not list a second row for a gradebook column named like an id-less content quiz", async () => {
    const { call, requested } = setupTool(base({
      [`${LE}/grades/`]: [gcol({ Name: "  quiz   3" })],
      [TOC_ALL_DATES]: tocOf(idlessTopic()),
      [`${LE}/quizzes/1408550`]: { QuizId: 1408550, Name: "Quiz 3", IsActive: true, GradeItemId: 900 },
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.id])).toEqual([["quiz", null]]);
    expect(requested.filter((p) => p.endsWith("/quizzes/1408550"))).toEqual([]);
  });

  it("still lists a gradebook column whose name matches no id-less content quiz", async () => {
    const { call } = setupTool(base({
      [`${LE}/grades/`]: [gcol({ Name: "Midterm" })],
      [TOC_ALL_DATES]: tocOf(idlessTopic()),
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.name])).toEqual([["quiz", "Quiz 3"], ["gradeOnly", "Midterm"]]);
  });
});

describe("get_assignments quiz discovery: gradebook column types", () => {
  it("recognizes a student-scored column by the documented GradeType, with no GradeObjectTypeId", async () => {
    const { call } = setupTool(base({
      [`${LE}/grades/`]: [gcol()],
      [`${LE}/quizzes/1408550`]: { QuizId: 1408550, Name: "Quiz 2", IsActive: true, GradeItemId: 900 },
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.id, a.source])).toEqual([["quiz", 1408550, "gradebook"]]);
  });

  it.each(["Numeric", "PassFail", "SelectBox", "Text"])(
    "lists a %s column as a gradeOnly row when nothing else covers it",
    async (GradeType) => {
      const { call } = setupTool(base({
        [`${LE}/grades/`]: [gcol({ GradeType, AssociatedTool: null, Name: "Midterm" })],
      }));

      const result = await call({ courseId: COURSE.Id });

      expect(result.assignments.map((a: any) => [a.type, a.name])).toEqual([["gradeOnly", "Midterm"]]);
    }
  );

  it.each(["Calculated", "Formula", "Category", "FinalCalculated"])(
    "ignores a %s column even when it carries a tool link",
    async (GradeType) => {
      const { call, requested } = setupTool(base({
        [`${LE}/grades/`]: [gcol({ GradeType })],
      }));

      const result = await call({ courseId: COURSE.Id });

      expect(result.assignments).toEqual([]);
      expect(requested.filter((p) => p.endsWith("/quizzes/1408550"))).toEqual([]);
    }
  );

  it("ignores a column that carries neither GradeType nor a student-scored GradeObjectTypeId", async () => {
    const { call } = setupTool(base({
      [`${LE}/grades/`]: [{ Id: 900, Name: "Mystery", AssociatedTool: null }],
    }));

    expect((await call({ courseId: COURSE.Id })).assignments).toEqual([]);
  });

  it("still accepts a column that carries only the numeric GradeObjectTypeId", async () => {
    const { call } = setupTool(base({
      [`${LE}/grades/`]: [{ Id: 900, Name: "Midterm", GradeObjectTypeId: 1, AssociatedTool: null }],
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments.map((a: any) => [a.type, a.name])).toEqual([["gradeOnly", "Midterm"]]);
  });
});

describe("get_assignments quiz discovery: gradebook probe volume", () => {
  const listedQuizOnTool2000 = {
    [`${LE}/quizzes/`]: { Objects: [{ QuizId: 66, Name: "Quiz 1", IsActive: true }] },
  };
  const known = gcol({ Id: 899, Name: "Quiz 1", AssociatedTool: { ToolId: 2000, ToolItemId: 66 } });
  const many = (count: number, tool: number) =>
    Array.from({ length: count }, (_, i) => gcol({ Id: 800 + i, Name: `Q${i}`, AssociatedTool: { ToolId: tool, ToolItemId: 3000 + i } }));
  const probesOf = (requested: string[]) => requested.filter((p) => /\/quizzes\/30\d\d$/.test(p));

  it("probes at most 20 columns when the quiz tool is known", async () => {
    const { call, requested } = setupTool(base({
      ...listedQuizOnTool2000,
      [`${LE}/grades/`]: [known, ...many(25, 2000)],
    }));

    await call({ courseId: COURSE.Id });

    expect(probesOf(requested)).toHaveLength(20);
  });

  it("probes at most 5 columns when no quiz tool is known", async () => {
    const { call, requested } = setupTool(base({
      [`${LE}/grades/`]: many(25, 2000),
    }));

    await call({ courseId: COURSE.Id });

    expect(probesOf(requested)).toHaveLength(5);
  });

  it("probes a column of the quiz tool but not a column of a different tool once a quiz tool is known", async () => {
    const { call, requested } = setupTool(base({
      ...listedQuizOnTool2000,
      [`${LE}/grades/`]: [
        known,
        gcol({ Id: 901, Name: "Quiz 2", AssociatedTool: { ToolId: 2000, ToolItemId: 88 } }),
        gcol({ Id: 902, Name: "Discussion", AssociatedTool: { ToolId: 3000, ToolItemId: 77 } }),
      ],
    }));

    await call({ courseId: COURSE.Id });

    expect(requested).toContain(`${LE}/quizzes/88`);
    expect(requested.filter((p) => p.endsWith("/quizzes/77"))).toEqual([]);
  });

  it("learns the quiz tool from a content quiz topic's ToolId", async () => {
    const { call, requested } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic({ ToolId: 2000, ToolItemId: 1408600 })),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
      [`${LE}/grades/`]: [
        gcol({ Id: 901, Name: "Quiz 2", AssociatedTool: { ToolId: 2000, ToolItemId: 88 } }),
        gcol({ Id: 902, Name: "Discussion", AssociatedTool: { ToolId: 3000, ToolItemId: 77 } }),
      ],
    }));

    await call({ courseId: COURSE.Id });

    expect(requested).toContain(`${LE}/quizzes/88`);
    expect(requested.filter((p) => p.endsWith("/quizzes/77"))).toEqual([]);
  });

  it("learns the quiz tool from a content quiz topic even when the quiz list already has that quiz", async () => {
    const { call, requested } = setupTool(base({
      [`${LE}/quizzes/`]: { Objects: [{ QuizId: 1408600, Name: "Quiz 3", IsActive: true }] },
      [TOC_ALL_DATES]: tocOf(quizTopic({ ToolId: 2000, ToolItemId: 1408600 })),
      [`${LE}/grades/`]: [
        gcol({ Id: 901, Name: "Quiz 2", AssociatedTool: { ToolId: 2000, ToolItemId: 88 } }),
        gcol({ Id: 902, Name: "Discussion", AssociatedTool: { ToolId: 3000, ToolItemId: 77 } }),
      ],
    }));

    await call({ courseId: COURSE.Id });

    expect(requested).toContain(`${LE}/quizzes/88`);
    expect(requested.filter((p) => p.endsWith("/quizzes/77"))).toEqual([]);
  });

  it("rejects a probed quiz whose own id differs from the column's tool item", async () => {
    const { call } = setupTool(base({
      [`${LE}/grades/`]: [gcol()],
      [`${LE}/quizzes/1408550`]: { QuizId: 999, Name: "Other", IsActive: true, GradeItemId: 900 },
    }));

    expect((await call({ courseId: COURSE.Id })).assignments.map((a: any) => a.type)).toEqual(["gradeOnly"]);
  });

  it("still finds a gradebook-only quiz when content already recovered another quiz", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
      [`${LE}/grades/`]: [gcol()],
      [`${LE}/quizzes/1408550`]: { QuizId: 1408550, Name: "Quiz 2", IsActive: true, GradeItemId: 900 },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id })).map((q: any) => q.source)).toEqual(["courseContent", "gradebook"]);
  });

  describe("negative cache", () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const probesOf1408550 = (requested: string[]) => requested.filter((p) => p.endsWith("/quizzes/1408550"));
    const refusing = (error: () => Error) => base({
      [`${LE}/grades/`]: [gcol()],
      [`${LE}/quizzes/1408550`]: () => { throw error(); },
    });

    it.each([["404", notFound], ["403", forbidden]])(
      "does not probe a quiz again within ten minutes of a %s",
      async (_status, error) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const { call, requested } = setupTool(refusing(error));

        await call({ courseId: COURSE.Id });
        vi.setSystemTime(Date.now() + 9 * 60_000);
        const second = await call({ courseId: COURSE.Id });

        expect(probesOf1408550(requested)).toHaveLength(1);
        expect(second.assignments.map((a: any) => a.type)).toEqual(["gradeOnly"]);
      }
    );

    it("probes again once the ten minutes have passed", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { call, requested } = setupTool(refusing(forbidden));

      await call({ courseId: COURSE.Id });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await call({ courseId: COURSE.Id });

      expect(probesOf1408550(requested)).toHaveLength(2);
    });

    it("does not remember a server error", async () => {
      const { call, requested } = setupTool(refusing(serverError));

      await call({ courseId: COURSE.Id });
      await call({ courseId: COURSE.Id });

      expect(probesOf1408550(requested)).toHaveLength(2);
    });

    it("does not remember a refusal across separate clients", async () => {
      const first = setupTool(refusing(forbidden));
      await first.call({ courseId: COURSE.Id });
      const second = setupTool(base({
        [`${LE}/grades/`]: [gcol()],
        [`${LE}/quizzes/1408550`]: { QuizId: 1408550, Name: "Quiz 2", IsActive: true, GradeItemId: 900 },
      }));

      expect(quizzesOf(await second.call({ courseId: COURSE.Id }))).toHaveLength(1);
    });
  });
});

describe("get_assignments quiz discovery: the content table of contents fallback", () => {
  const withDatedTocFailing = (error: () => Error) => base({
    [TOC_ALL_DATES]: () => { throw error(); },
    [TOC_PLAIN]: tocOf(quizTopic()),
    [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
  });

  it.each([["400", badRequest], ["403", forbidden], ["404", notFound]])(
    "falls back to the plain table of contents on a %s and marks coverage incomplete",
    async (_status, error) => {
      const { call, requested } = setupTool(withDatedTocFailing(error));

      const result = await call({ courseId: COURSE.Id });

      expect(requested).toContain(TOC_PLAIN);
      expect(quizzesOf(result).map((q: any) => q.name)).toEqual(["Quiz 3"]);
      expect(result.quizCoverage).toBe("incomplete");
    }
  );

  it.each([
    ["429", () => Object.assign(new Error("Too Many Requests"), { status: 429 })],
    ["500", serverError],
    ["502", () => Object.assign(new Error("Bad Gateway"), { status: 502 })],
    ["a network failure", () => new Error("fetch failed")],
    ["a timeout", () => Object.assign(new Error("timed out"), { name: "TimeoutError" })],
  ])("does not ask for the plain table of contents after %s", async (_what, error) => {
    const { call, requested } = setupTool(withDatedTocFailing(error));

    const result = await call({ courseId: COURSE.Id });

    expect(requested).not.toContain(TOC_PLAIN);
    expect(result.quizCoverage).toBe("incomplete");
    expect(result.quizCoverageNote).toMatch(/^Brightspace did not return the course content \(/);
  });

  it("reports sign-in pending, not a plain-TOC fallback, when the date-inclusive TOC says 401", async () => {
    const { call, requested } = setupTool(base({
      [TOC_ALL_DATES]: () => { throw new ApiError(401, TOC_ALL_DATES, "expired"); },
      [TOC_PLAIN]: tocOf(),
    }));

    expect((await call({ courseId: COURSE.Id })).authPending).toBe(true);
    expect(requested).not.toContain(TOC_PLAIN);
  });

  it("reports sign-in pending when a gradebook probe says 401", async () => {
    const { call } = setupTool(base({
      [`${LE}/grades/`]: [gcol()],
      [`${LE}/quizzes/1408550`]: () => { throw new ApiError(401, "x", "expired"); },
    }));

    expect((await call({ courseId: COURSE.Id })).authPending).toBe(true);
  });

  it("reports sign-in pending when a content quiz read says 401", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: () => { throw new ApiError(401, "x", "expired"); },
    }));

    expect((await call({ courseId: COURSE.Id })).authPending).toBe(true);
  });
});

describe("get_assignments quiz discovery: what a row says about itself", () => {
  const NOW = new Date("2026-10-13T12:00:00.000Z");
  afterEach(() => {
    vi.useRealTimers();
  });

  const listed = (over: Record<string, unknown>) =>
    base({ [`${LE}/quizzes/`]: { Objects: [{ QuizId: 7, Name: "Quiz 7", IsActive: true, ...over }] } });
  const availabilityOf = async (over: Record<string, unknown>) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { call } = setupTool(listed(over));
    return quizzesOf(await call({ courseId: COURSE.Id }))[0].availability;
  };

  it("marks a quiz whose start date is ahead as notYetOpen", async () => {
    expect(await availabilityOf({ StartDate: "2026-10-20T00:00:00.000Z", EndDate: "2026-10-27T00:00:00.000Z" })).toBe("notYetOpen");
  });

  it("marks a quiz inside its window as open", async () => {
    expect(await availabilityOf({ StartDate: "2026-10-10T00:00:00.000Z", EndDate: "2026-10-20T00:00:00.000Z" })).toBe("open");
  });

  it("marks a quiz past its end date as closed", async () => {
    expect(await availabilityOf({ StartDate: "2026-10-01T00:00:00.000Z", EndDate: "2026-10-05T00:00:00.000Z" })).toBe("closed");
  });

  it("marks a quiz with only an end date in the past as closed", async () => {
    expect(await availabilityOf({ EndDate: "2026-10-05T00:00:00.000Z" })).toBe("closed");
  });

  it("marks a quiz with only a start date in the past as open", async () => {
    expect(await availabilityOf({ StartDate: "2026-10-05T00:00:00.000Z" })).toBe("open");
  });

  it("omits availability when the quiz has no start or end date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { call } = setupTool(listed({ DueDate: "2026-10-05T00:00:00.000Z" }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0]).not.toHaveProperty("availability");
  });

  it("omits availability when the dates cannot be parsed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { call } = setupTool(listed({ StartDate: "soon", EndDate: "later" }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0]).not.toHaveProperty("availability");
  });

  it("marks a quiz built from content metadata only as details unavailable, with a note", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: () => { throw forbidden(); },
    }));

    const [quiz] = quizzesOf(await call({ courseId: COURSE.Id }));

    expect(quiz.detailsStatus).toBe("unavailable");
    expect(quiz.detailsStatusNote).toMatch(/^Brightspace showed this quiz in the course content but would not return its details to you;/);
    expect(quiz.detailsStatusNote).toMatch(/Open the link to check\.$/);
  });

  it("marks an id-less content quiz as details unavailable", async () => {
    const { call } = setupTool(base({ [TOC_ALL_DATES]: tocOf(idlessTopic()) }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0].detailsStatus).toBe("unavailable");
  });

  it("does not emit detailsStatus on a listed quiz or a content quiz that was read", async () => {
    const { call } = setupTool(base({
      [`${LE}/quizzes/`]: { Objects: [{ QuizId: 7, Name: "Quiz 7", IsActive: true }] },
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
    }));

    const quizzes = quizzesOf(await call({ courseId: COURSE.Id }));

    expect(quizzes).toHaveLength(2);
    for (const quiz of quizzes) {
      expect(quiz).not.toHaveProperty("detailsStatus");
      expect(quiz).not.toHaveProperty("detailsStatusNote");
    }
  });

  it("flags a quiz topic exempt from the activity as exempt, and still lists it", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic({ IsExempt: true })),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Practice Quiz", IsActive: true },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0]).toMatchObject({ name: "Practice Quiz", exempt: true });
  });

  it("flags an exempt topic that fell back to content metadata", async () => {
    const { call } = setupTool(base({ [TOC_ALL_DATES]: tocOf(idlessTopic({ IsExempt: true })) }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0].exempt).toBe(true);
  });

  it("does not emit exempt on an ordinary quiz", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0]).not.toHaveProperty("exempt");
  });
});

describe("get_assignments quiz discovery: attempts for quizzes the list did not return", () => {
  it("reads a 404 from a listed quiz's attempts as zero attempts", async () => {
    const { call } = setupTool(base({
      [`${LE}/quizzes/`]: { Objects: [{ QuizId: 7, Name: "Quiz 7", IsActive: true }] },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0]).toMatchObject({
      attemptStatus: "known",
      attemptsUsed: 0,
    });
  });

  it("reads a 404 from a content-found quiz's attempts as unknown", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0]).toMatchObject({
      attemptStatus: "unknown",
      attemptsUsed: null,
      attemptsAvailable: false,
    });
  });

  it("reads a 404 from a gradebook-found quiz's attempts as unknown", async () => {
    const { call } = setupTool(base({
      [`${LE}/grades/`]: [gcol()],
      [`${LE}/quizzes/1408550`]: { QuizId: 1408550, Name: "Quiz 2", IsActive: true, GradeItemId: 900 },
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0].attemptStatus).toBe("unknown");
  });

  it("keeps real attempts for a content-found quiz when the attempts route answers", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: true },
      [`${LE}/quizzes/1408600/attempts/`]: [{ AttemptId: 1, AttemptNumber: 1, Score: 8, IsCompleted: true, CompletedDate: null }],
    }));

    expect(quizzesOf(await call({ courseId: COURSE.Id }))[0]).toMatchObject({
      attemptStatus: "known",
      attemptsUsed: 1,
      bestScore: 8,
    });
  });
});

describe("get_assignments quiz discovery: items that are deliberately not shown", () => {
  const typesOf = (result: any) => result.assignments.map((a: any) => [a.type, a.name]);

  it("lists no gradeOnly row for the column of a listed quiz the instructor marked inactive", async () => {
    const { call, requested } = setupTool(base({
      [`${LE}/quizzes/`]: { Objects: [{ QuizId: 66, Name: "Retired Quiz", IsActive: false }] },
      [`${LE}/grades/`]: [gcol({ Id: 899, Name: "Retired Quiz", AssociatedTool: { ToolId: 2000, ToolItemId: 66 } })],
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments).toEqual([]);
    expect(requested.filter((p) => p.includes("/quizzes/66"))).toEqual([]);
  });

  it("lists no gradeOnly row for an inactive quiz that content recovery found", async () => {
    const { call } = setupTool(base({
      [TOC_ALL_DATES]: tocOf(quizTopic()),
      [`${LE}/quizzes/1408600`]: { QuizId: 1408600, Name: "Quiz 3", IsActive: false, GradeItemId: 900 },
      [`${LE}/grades/`]: [gcol({ Id: 900, Name: "Quiz 3", AssociatedTool: { ToolId: 2000, ToolItemId: 1408600 } })],
    }));

    expect((await call({ courseId: COURSE.Id })).assignments).toEqual([]);
  });

  it("lists no gradeOnly row for an inactive quiz that a gradebook probe found", async () => {
    const { call, requested } = setupTool(base({
      [`${LE}/grades/`]: [gcol()],
      [`${LE}/quizzes/1408550`]: { QuizId: 1408550, Name: "Quiz 2", IsActive: false, GradeItemId: 900 },
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(requested).toContain(`${LE}/quizzes/1408550`);
    expect(result.assignments).toEqual([]);
  });

  it("lists no gradeOnly row for the column of a hidden dropbox folder, and does not probe it", async () => {
    const { call, requested } = setupTool(base({
      [`${LE}/dropbox/folders/`]: [{ Id: 55, Name: "Hidden HW", DueDate: null, IsHidden: true, GroupTypeId: null }],
      [`${LE}/grades/`]: [gcol({ Id: 901, Name: "Hidden HW", AssociatedTool: { ToolId: 1000, ToolItemId: 55 } })],
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(result.assignments).toEqual([]);
    expect(requested.filter((p) => p.endsWith("/quizzes/55"))).toEqual([]);
  });

  it("ignores a hidden grade column in both gradebook paths and keeps its visible sibling", async () => {
    const { call, requested } = setupTool(base({
      [`${LE}/grades/`]: [
        gcol({ Id: 900, Name: "Secret Exam", IsHidden: true, AssociatedTool: null }),
        gcol({ Id: 901, Name: "Secret Quiz", IsHidden: true, AssociatedTool: { ToolId: 2000, ToolItemId: 1408551 } }),
        gcol({ Id: 902, Name: "Midterm", IsHidden: false, AssociatedTool: null }),
      ],
    }));

    const result = await call({ courseId: COURSE.Id });

    expect(typesOf(result)).toEqual([["gradeOnly", "Midterm"]]);
    expect(requested.filter((p) => p.endsWith("/quizzes/1408551"))).toEqual([]);
  });
});

describe("get_assignments quiz discovery: content recovery volume", () => {
  const topics = (count: number) => Array.from({ length: count }, (_, i) => quizTopic({
    TopicId: 6000 + i,
    Title: `Quiz ${i}`,
    Url: `/d2l/common/dialogs/quickLink/quickLink.d2l?ou=${COURSE.Id}&type=quiz&rcode=ABC-${7000 + i}`,
    ToolItemId: 7000 + i,
  }));
  const quizRoutes = (count: number): Routes => Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `${LE}/quizzes/${7000 + i}`,
      { QuizId: 7000 + i, Name: `Quiz ${i}`, IsActive: true },
    ])
  );
  const readsOf = (requested: string[]) => requested.filter((p) => /\/quizzes\/7\d{3}$/.test(p));

  it("reads exactly 30 content quizzes, lists the rest from the table of contents, and says so", async () => {
    const { call, requested } = setupTool(base({ [TOC_ALL_DATES]: tocOf(...topics(35)), ...quizRoutes(35) }));

    const result = await call({ courseId: COURSE.Id });

    expect(readsOf(requested)).toHaveLength(30);
    expect(quizzesOf(result)).toHaveLength(35);
    expect(quizzesOf(result).filter((q: any) => q.detailsStatus === "unavailable")).toHaveLength(5);
    expect(result.quizCoverage).toBe("incomplete");
    expect(result.quizCoverageNote).toMatch(/^Brightspace read the details of only the first 30 of 35 quizzes found in the course content/);
  });

  it("reads all 30 and stays complete when the course has exactly 30 content quizzes", async () => {
    const { call, requested } = setupTool(base({ [TOC_ALL_DATES]: tocOf(...topics(30)), ...quizRoutes(30) }));

    const result = await call({ courseId: COURSE.Id });

    expect(readsOf(requested)).toHaveLength(30);
    expect(quizzesOf(result)).toHaveLength(30);
    expect(result.quizCoverage).toBe("complete");
  });

  it("caps the topic-detail reads of unreadable content quizzes at 30 as well", async () => {
    const { call, requested } = setupTool(base({ [TOC_ALL_DATES]: tocOf(...topics(35).map((t) => ({ ...t, ToolItemId: null, Url: "" }))) }));

    const result = await call({ courseId: COURSE.Id });

    expect(requested.filter((p) => /\/content\/topics\/\d+$/.test(p))).toHaveLength(30);
    expect(quizzesOf(result)).toHaveLength(35);
    expect(result.quizCoverage).toBe("incomplete");
  });
});
