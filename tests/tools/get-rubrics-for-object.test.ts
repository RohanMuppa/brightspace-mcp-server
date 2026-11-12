import { describe, it, expect, vi } from "vitest";
import { registerGetRubricsForObject } from "../../src/tools/get-rubrics-for-object.js";
import { ApiError } from "../../src/api/errors.js";

const COURSE_ID = 101;
const FOLDER_ID = 55;

const notFound = (): never => { throw new ApiError(404, "/dropbox/folders/", "Not Found"); };
const forbidden = (): never => { throw new ApiError(403, "/dropbox/folders/", "Forbidden"); };

function setup(respond: (path: string) => unknown) {
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => respond(path)),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetRubricsForObject(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args) };
}

const body = (result: any) => JSON.parse(result.content[0].text);

const rubricFolder = () => ({
  Id: FOLDER_ID,
  Name: "HW 1",
  Assessment: {
    ScoreDenominator: 100,
    Rubrics: [
      {
        RubricId: 9,
        Name: "Lab rubric",
        Criteria: [
          {
            CriterionId: 1,
            Name: "Correctness",
            Levels: [{ LevelId: 1, Name: "Excellent", Points: 10, Description: { Text: "Flawless", Html: "" } }],
          },
        ],
      },
    ],
  },
});

describe("get_rubrics_for_object", () => {
  it("handles a bare-array folders response", async () => {
    const { call } = setup(() => [rubricFolder()]);
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.rubrics).toHaveLength(1);
    expect(parsed.rubrics[0].criteria[0].levels[0]).toMatchObject({ levelId: 1, points: 10 });
  });

  it("handles an {Objects: []}-wrapped folders response", async () => {
    const { call } = setup(() => ({ Objects: [rubricFolder()] }));
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID });

    const parsed = body(result);
    expect(parsed.rubrics).toHaveLength(1);
  });

  // Students can read the folder list, so a 403 must not blame a missing staff role (#437).
  it("explains a 403 as enrolment or a hidden Assignments tool, not a staff-only read", async () => {
    const { call } = setup(forbidden);
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).not.toContain("Instructor or TA");
    expect(text).toContain("refused to list this course's assignment folders");
    expect(text).toContain("not enrolled");
    expect(text).toContain("get_my_courses");
  });

  it("returns an empty rubrics list with a note on 404, not a failure", async () => {
    const { call } = setup(notFound);
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.rubrics).toEqual([]);
    expect(parsed.note).toBeTruthy();
  });

  it("returns an empty rubrics list with a note when the folder has none attached", async () => {
    const { call } = setup(() => [{ Id: FOLDER_ID, Name: "HW 1", Assessment: { ScoreDenominator: 100, Rubrics: [] } }]);
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID });

    const parsed = body(result);
    expect(parsed.rubrics).toEqual([]);
    expect(parsed.note).toBe("No rubrics are attached to this dropbox folder.");
  });

  it("returns an empty rubrics list with a note when the folder id itself doesn't exist", async () => {
    const { call } = setup(() => [rubricFolder()]);
    const result = await call({ courseId: COURSE_ID, folderId: 999 });

    const parsed = body(result);
    expect(parsed.rubrics).toEqual([]);
    expect(parsed.note).toContain("999");
  });
});
