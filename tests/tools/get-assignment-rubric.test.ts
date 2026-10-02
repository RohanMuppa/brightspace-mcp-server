import { describe, it, expect, vi } from "vitest";
import {
  registerGetAssignmentRubric,
  fetchAssignmentRubrics,
} from "../../src/tools/get-assignment-rubric.js";
import { ApiError } from "../../src/api/errors.js";

/**
 * get_assignments only ever surfaced rubric NAMES. This tool answers "what
 * does the rubric actually want": the full criteria/level/points table, plus
 * the student's own graded outcome once it's released.
 *
 * Shapes below mirror the real D2L analytic-rubric payload: a criteria group
 * owns a shared Levels column list, and each criterion carries one Cell per
 * level with that criterion x level pair's own points/description.
 */

const COURSE = 101;
const FOLDER = 7001;

// These must actually THROW (not return) an error when invoked as a thunk,
// so that a mocked route truly rejects instead of "succeeding" with an Error
// object as its resolved value — a prior version of this helper returned
// the error instead of throwing it, which let the 403/404 tests below pass
// without ever exercising the tool's catch block.
const notFound = (): never => { throw new ApiError(404, "/dropbox/folders", "Not Found"); };
const forbidden = (): never => { throw new ApiError(403, "/dropbox/folders", "Forbidden"); };

const rubric = (overrides: Record<string, unknown> = {}) => ({
  RubricId: 8001,
  Name: "Lab 4 rubric",
  Description: { Text: "", Html: "" },
  ScoringMethod: 3,
  CriteriaGroups: [
    {
      Name: "Analysis",
      Levels: [
        { Id: 8201, Name: "Excellent", Points: 5 },
        { Id: 8202, Name: "Poor", Points: 0 },
      ],
      Criteria: [
        {
          Id: 8301,
          Name: "Identifies issues",
          Cells: [
            { LevelId: 8201, Description: { Text: "", Html: "<p>Identifies <b>all</b> issues.</p>" }, Points: 5 },
            { LevelId: 8202, Description: { Text: "Identifies few issues.", Html: "" }, Points: 0 },
          ],
        },
      ],
    },
  ],
  ...overrides,
});

function folderWith(assessment: Record<string, unknown> | null) {
  return { Id: FOLDER, Assessment: assessment };
}

interface Setup {
  folderResult: unknown | (() => never);
  rubricsListResult?: unknown | (() => never);
  feedbackResult?: unknown | (() => never);
}

function setup({ folderResult, rubricsListResult, feedbackResult }: Setup) {
  const requested: string[] = [];
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      if (path.endsWith(`/dropbox/folders/${FOLDER}`)) {
        if (typeof folderResult === "function") return (folderResult as () => never)();
        return folderResult;
      }
      if (path.includes("/rubrics?objectType=Dropbox")) {
        if (rubricsListResult === undefined) throw notFound();
        if (typeof rubricsListResult === "function") return (rubricsListResult as () => never)();
        return rubricsListResult;
      }
      if (path.endsWith(`/dropbox/folders/${FOLDER}/feedback/myFeedback/`)) {
        if (feedbackResult === undefined) throw notFound();
        if (typeof feedbackResult === "function") return (feedbackResult as () => never)();
        return feedbackResult;
      }
      throw notFound();
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetAssignmentRubric(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), requested, apiClient };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe("get_assignment_rubric: folder with inline rubrics", () => {
  it("returns the full criteria/level/points table from Assessment.Rubrics", async () => {
    const { call, requested } = setup({
      folderResult: folderWith({ Rubrics: [rubric()] }),
    });

    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));

    expect(payload.rubrics).toHaveLength(1);
    const [r] = payload.rubrics;
    expect(r.rubricId).toBe(8001);
    expect(r.name).toBe("Lab 4 rubric");
    expect(r.scoringMethod).toBe(3);
    expect(r.criteriaGroups).toEqual([
      {
        name: "Analysis",
        criteria: [
          {
            name: "Identifies issues",
            levels: [
              { name: "Excellent", points: 5, description: "Identifies **all** issues." },
              { name: "Poor", points: 0, description: "Identifies few issues." },
            ],
          },
        ],
      },
    ]);
    expect(r.totalPoints).toBe(5);
    expect(r.rubricAssessment).toBeUndefined();

    // Rubrics rode along on the folder, so the fallback listing was never asked.
    expect(requested.some((p) => p.includes("/rubrics?objectType=Dropbox"))).toBe(false);
  });

  it("omits totalPoints for a purely text rubric with no points anywhere", async () => {
    const textOnly = rubric({
      CriteriaGroups: [
        {
          Name: "Writing",
          Levels: [{ Id: 1, Name: "Good", Points: null }],
          Criteria: [
            {
              Id: 2,
              Name: "Clarity",
              Cells: [{ LevelId: 1, Description: { Text: "Clear.", Html: "" }, Points: null }],
            },
          ],
        },
      ],
    });
    const { call } = setup({ folderResult: folderWith({ Rubrics: [textOnly] }) });

    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));
    expect(payload.rubrics[0].totalPoints).toBeUndefined();
  });
});

describe("get_assignment_rubric: fallback to the rubrics endpoint", () => {
  it("asks /rubrics?objectType=Dropbox when the folder carries no embedded rubric", async () => {
    const { call, requested } = setup({
      folderResult: folderWith({ Rubrics: [] }),
      rubricsListResult: [rubric()],
    });

    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));

    expect(payload.rubrics).toHaveLength(1);
    expect(payload.rubrics[0].rubricId).toBe(8001);
    expect(requested).toContain(
      `/d2l/api/le/1.0/${COURSE}/rubrics?objectType=Dropbox&objectId=${FOLDER}`
    );
  });

  it("also falls back when Assessment itself is missing", async () => {
    const { call, requested } = setup({
      folderResult: folderWith(null),
      rubricsListResult: { Objects: [rubric()] },
    });

    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));
    expect(payload.rubrics).toHaveLength(1);
    expect(requested.some((p) => p.includes("/rubrics?objectType=Dropbox"))).toBe(true);
  });

  it("returns empty with a note when neither source has a rubric", async () => {
    const { call } = setup({
      folderResult: folderWith({ Rubrics: [] }),
      // No rubricsListResult set -> the fallback 404s.
    });

    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));
    expect(payload.rubrics).toEqual([]);
    expect(payload.note).toMatch(/no rubric/i);
  });
});

describe("get_assignment_rubric: access failures never surface as errors", () => {
  it("403 on the folder returns empty rubrics with a permission-specific note", async () => {
    const { call } = setup({ folderResult: forbidden });

    const result = await call({ courseId: COURSE, assignmentId: FOLDER });
    expect(result.isError).toBeFalsy();
    const payload = parse(result);
    expect(payload.rubrics).toEqual([]);
    expect(payload.note).toMatch(/permission/i);
  });

  it("404 on the folder returns empty rubrics with a not-found note", async () => {
    const { call } = setup({ folderResult: notFound });

    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));
    expect(payload.rubrics).toEqual([]);
    expect(payload.note).toMatch(/not found/i);
  });
});

describe("get_assignment_rubric: student's own outcome", () => {
  it("merges myFeedback's RubricAssessments per criterion, additively", async () => {
    const { call } = setup({
      folderResult: folderWith({ Rubrics: [rubric()] }),
      feedbackResult: {
        Score: 5,
        Feedback: null,
        RubricAssessments: [
          {
            RubricId: 8001,
            OverallOutcome: { LevelId: 8201, Score: 5, Feedback: { Text: "", Html: "<p>Nice work.</p>" } },
            CriteriaOutcome: [
              { CriterionId: 8301, LevelId: 8201, Score: 5, Feedback: { Text: "", Html: "" } },
            ],
          },
        ],
      },
    });

    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));
    const assessment = payload.rubrics[0].rubricAssessment;

    expect(assessment).toEqual({
      levelName: "Excellent",
      score: 5,
      feedback: "Nice work.",
      criteria: [
        { criterionName: "Identifies issues", levelName: "Excellent", score: 5 },
      ],
    });
  });

  it("merges the documented flat OverallScore/OverallLevel/OverallFeedback shape", async () => {
    // D2L's documented Dropbox RubricAssessment carries the overall outcome
    // as flat fields rather than a nested OverallOutcome object.
    const { call } = setup({
      folderResult: folderWith({ Rubrics: [rubric()] }),
      feedbackResult: {
        Score: 5,
        Feedback: null,
        RubricAssessments: [
          {
            RubricId: 8001,
            OverallScore: 5,
            OverallLevel: 8201,
            OverallFeedback: { Text: "", Html: "<p>Nice work.</p>" },
            CriteriaOutcome: [
              { CriterionId: 8301, LevelId: 8201, Score: 5, Feedback: { Text: "", Html: "" } },
            ],
          },
        ],
      },
    });

    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));
    const assessment = payload.rubrics[0].rubricAssessment;

    expect(assessment).toEqual({
      levelName: "Excellent",
      score: 5,
      feedback: "Nice work.",
      criteria: [
        { criterionName: "Identifies issues", levelName: "Excellent", score: 5 },
      ],
    });
  });

  it("tolerates a flat-shape assessment with no CriteriaOutcome at all", async () => {
    const { call } = setup({
      folderResult: folderWith({ Rubrics: [rubric()] }),
      feedbackResult: {
        RubricAssessments: [
          { RubricId: 8001, OverallScore: 5, OverallLevel: 8201, OverallFeedback: null },
        ],
      },
    });

    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));
    const assessment = payload.rubrics[0].rubricAssessment;

    expect(assessment.score).toBe(5);
    expect(assessment.levelName).toBe("Excellent");
    expect(assessment.criteria).toEqual([]);
  });

  it("omits rubricAssessment entirely when myFeedback has none", async () => {
    const { call } = setup({
      folderResult: folderWith({ Rubrics: [rubric()] }),
      feedbackResult: { Score: null, Feedback: null, RubricAssessments: [] },
    });

    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));
    expect(payload.rubrics[0].rubricAssessment).toBeUndefined();
  });

  it("never calls an unstable rubric-assessment route", async () => {
    const { call, requested } = setup({
      folderResult: folderWith({ Rubrics: [rubric()] }),
      feedbackResult: { RubricAssessments: [] },
    });

    await call({ courseId: COURSE, assignmentId: FOLDER });
    expect(requested.some((p) => p.includes("/unstable/"))).toBe(false);
  });

  it("swallows a 403/404 on myFeedback but rethrows anything else (e.g. a network error)", async () => {
    const { call } = setup({
      folderResult: folderWith({ Rubrics: [rubric()] }),
      feedbackResult: () => {
        throw new Error("socket hang up");
      },
    });

    const result = await call({ courseId: COURSE, assignmentId: FOLDER });
    expect(result.isError).toBe(true);
  });
});

describe("get_assignment_rubric: scoringMethodName", () => {
  it("names the known D2L SCORING_M values", async () => {
    const cases: [number, string][] = [
      [0, "TextOnly"],
      [1, "Points"],
      [2, "TextAndNumeric"],
      [3, "CustomPoints"],
    ];

    for (const [value, name] of cases) {
      const { call } = setup({
        folderResult: folderWith({ Rubrics: [rubric({ ScoringMethod: value })] }),
      });
      const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));
      expect(payload.rubrics[0].scoringMethod).toBe(value);
      expect(payload.rubrics[0].scoringMethodName).toBe(name);
    }
  });

  it("omits scoringMethodName for an unrecognized value, keeping the raw number", async () => {
    const { call } = setup({
      folderResult: folderWith({ Rubrics: [rubric({ ScoringMethod: 99 })] }),
    });
    const payload = parse(await call({ courseId: COURSE, assignmentId: FOLDER }));
    expect(payload.rubrics[0].scoringMethod).toBe(99);
    expect(payload.rubrics[0].scoringMethodName).toBeUndefined();
  });
});

describe("get_assignment_rubric: input validation", () => {
  it("rejects a missing assignmentId", async () => {
    const { call } = setup({ folderResult: folderWith({ Rubrics: [rubric()] }) });

    const result = await call({ courseId: COURSE });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/assignmentId/i);
  });

  it("rejects a missing courseId", async () => {
    const { call } = setup({ folderResult: folderWith({ Rubrics: [rubric()] }) });

    const result = await call({ assignmentId: FOLDER });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/courseId/i);
  });
});

describe("fetchAssignmentRubrics (direct)", () => {
  it("is exported for reuse the way fetchCourseAssignments is", async () => {
    const apiClient = {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        if (path.endsWith(`/dropbox/folders/${FOLDER}`)) return folderWith({ Rubrics: [rubric()] });
        throw notFound();
      }),
    };

    const result = await fetchAssignmentRubrics(apiClient as any, COURSE, FOLDER);
    expect(result.rubrics).toHaveLength(1);
  });
});
