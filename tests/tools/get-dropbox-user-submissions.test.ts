import { describe, it, expect, vi } from "vitest";
import { registerGetDropboxUserSubmissions } from "../../src/tools/get-dropbox-user-submissions.js";
import { ApiError } from "../../src/api/errors.js";

const COURSE_ID = 101;
const FOLDER_ID = 55;
const USER_ID = 501;

const notFound = (): never => { throw new ApiError(404, "/submissions/users", "Not Found"); };
const forbidden = (): never => { throw new ApiError(403, "/submissions/users", "Forbidden"); };

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

  registerGetDropboxUserSubmissions(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args) };
}

const body = (result: any) => JSON.parse(result.content[0].text);

const submission = () => ({
  Id: 9001,
  SubmittedBy: { Identifier: String(USER_ID), DisplayName: "Sam Student" },
  SubmissionDate: "2026-09-09T12:00:00.000Z",
  Comment: { Text: "here you go", Html: "" },
  Files: [{ FileId: 1, FileName: "hw1.pdf", Size: 1024 }],
});

describe("get_dropbox_user_submissions", () => {
  it("handles a bare-array response", async () => {
    const { call } = setup((path) => {
      if (path.endsWith(`/submissions/users/${USER_ID}`)) return [submission()];
      throw notFound();
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, userId: USER_ID, ignoreFeedback: true });
    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.submissions).toHaveLength(1);
    expect(parsed.submissions[0]).toMatchObject({ submissionId: 9001, comment: "here you go" });
  });

  it("handles an {Objects: []}-wrapped response", async () => {
    const { call } = setup((path) => {
      if (path.endsWith(`/submissions/users/${USER_ID}`)) return { Objects: [submission()] };
      throw notFound();
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, userId: USER_ID, ignoreFeedback: true });
    const parsed = body(result);
    expect(parsed.submissions).toHaveLength(1);
  });

  it("returns a clear instructor/TA note on 403, not a generic error", async () => {
    const { call } = setup(forbidden);
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, userId: USER_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Instructor or TA access required for this course");
  });

  it("returns an empty list with a note on 404, not a failure", async () => {
    const { call } = setup(notFound);
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, userId: USER_ID });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.submissions).toEqual([]);
    expect(parsed.note).toBeTruthy();
  });

  it("returns an empty list with a note when the user has nothing submitted", async () => {
    const { call } = setup((path) => {
      if (path.endsWith(`/submissions/users/${USER_ID}`)) return [];
      throw notFound();
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, userId: USER_ID });
    const parsed = body(result);
    expect(parsed.submissions).toEqual([]);
    expect(parsed.note).toBe("No submissions found for this user in the specified folder.");
  });

  it("attaches feedback status when available", async () => {
    const { call } = setup((path) => {
      if (path.endsWith(`/submissions/users/${USER_ID}`)) return [submission()];
      if (path.includes(`/feedback/user/${USER_ID}`)) {
        return { Score: 88, Feedback: { Text: "Good job", Html: "" }, IsGraded: true };
      }
      throw notFound();
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, userId: USER_ID });
    const parsed = body(result);
    expect(parsed.feedbackStatus).toMatchObject({ isGraded: true, score: 88, feedbackText: "Good job" });
  });
});
