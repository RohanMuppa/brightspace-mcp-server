import { describe, it, expect, vi } from "vitest";
import { registerGetDropboxFeedback } from "../../src/tools/get-dropbox-feedback.js";
import { ApiError } from "../../src/api/errors.js";

const COURSE_ID = 101;
const FOLDER_ID = 55;
const USER_ID = 501;

const notFound = (): never => { throw new ApiError(404, "/feedback/user", "Not Found"); };
const forbidden = (): never => { throw new ApiError(403, "/feedback/user", "Forbidden"); };

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

  registerGetDropboxFeedback(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args) };
}

const body = (result: any) => JSON.parse(result.content[0].text);

describe("get_dropbox_feedback", () => {
  it("returns feedback with a markdown rendering of the HTML body", async () => {
    const { call } = setup(() => ({
      Score: 95,
      Feedback: { Text: "Great job", Html: "<p>Great <b>job</b></p>" },
      IsGraded: true,
      RubricAssessments: [
        {
          RubricId: 7,
          Name: "Lab rubric",
          TotalPoints: 10,
          Criteria: [{ CriterionId: 1, LevelId: 2, Points: 5, Comments: { Text: "nice", Html: "" } }],
        },
      ],
    }));

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, entityType: "user", entityId: USER_ID });
    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.feedback.score).toBe(95);
    expect(parsed.feedback.feedbackMarkdown).toContain("**job**");
    expect(parsed.feedback.rubricAssessments[0]).toMatchObject({ rubricId: 7, criteria: [{ criterionId: 1, points: 5 }] });
  });

  it("returns a clear instructor/TA note on 403, not a generic error", async () => {
    const { call } = setup(forbidden);
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, entityType: "user", entityId: USER_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Instructor or TA access required for this course");
  });

  it("returns feedback: null with a note on 404 (not graded yet), not a failure", async () => {
    const { call } = setup(notFound);
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, entityType: "user", entityId: USER_ID });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.feedback).toBeNull();
    expect(parsed.note).toContain("not been graded yet");
  });

  it("treats a null Criteria array on a rubric assessment as empty, not a crash", async () => {
    const { call } = setup(() => ({
      Score: 80,
      Feedback: null,
      IsGraded: true,
      RubricAssessments: [
        { RubricId: 7, Name: "Lab rubric", TotalPoints: 10, Criteria: null },
      ],
    }));

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, entityType: "user", entityId: USER_ID });
    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.feedback.rubricAssessments[0]).toMatchObject({ rubricId: 7, criteria: [] });
  });

  it("supports entityType group", async () => {
    const requested: string[] = [];
    const { call } = setup((path) => {
      requested.push(path);
      return { Score: null, Feedback: null, IsGraded: false, RubricAssessments: null };
    });

    await call({ courseId: COURSE_ID, folderId: FOLDER_ID, entityType: "group", entityId: 42 });
    expect(requested[0]).toContain("/feedback/group/42");
  });
});
