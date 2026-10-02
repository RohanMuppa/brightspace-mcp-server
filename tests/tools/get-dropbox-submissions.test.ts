import { describe, it, expect, vi } from "vitest";
import { registerGetDropboxSubmissions } from "../../src/tools/get-dropbox-submissions.js";
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

  registerGetDropboxSubmissions(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), apiClient };
}

const body = (result: any) => JSON.parse(result.content[0].text);

const folder = { Id: FOLDER_ID, Name: "HW 1", DueDate: "2026-09-10T00:00:00.000Z", Assessment: { ScoreDenominator: 100 } };

const submission = (overrides: Record<string, unknown> = {}) => ({
  Id: 9001,
  SubmittedBy: { Identifier: "501", DisplayName: "Sam Student" },
  SubmissionDate: "2026-09-09T12:00:00.000Z",
  Comment: null,
  Files: [{ FileId: 1, FileName: "hw1.pdf", Size: 1024 }],
  ...overrides,
});

describe("get_dropbox_submissions", () => {
  it("handles a bare-array submissions response alongside an {Objects} folders response", async () => {
    const { call } = setup((path) => {
      if (path.endsWith("/dropbox/folders/")) return { Objects: [folder] };
      if (path.endsWith("/submissions/")) return [submission()];
      // feedback lookup per submitter: none yet
      throw notFound();
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID });
    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.submissions).toHaveLength(1);
    expect(parsed.submissions[0]).toMatchObject({ submissionId: 9001, userId: "501", isLate: false });
    expect(parsed.folderName).toBe("HW 1");
  });

  it("handles a bare-array folders response alongside an {Objects} submissions response", async () => {
    const { call } = setup((path) => {
      if (path.endsWith("/dropbox/folders/")) return [folder];
      if (path.endsWith("/submissions/")) return { Objects: [submission()] };
      throw notFound();
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, ignoreFeedback: true });
    const parsed = body(result);
    expect(parsed.submissions).toHaveLength(1);
    expect(parsed.submissions[0].feedbackStatus).toBeUndefined();
  });

  it("returns a clear instructor/TA note on 403, not a generic error", async () => {
    const { call } = setup(forbidden);
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Instructor or TA access required for this course");
  });

  it("returns an empty submissions list with a note on 404, not a failure", async () => {
    const { call } = setup(notFound);
    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.submissions).toEqual([]);
    expect(parsed.note).toContain(String(FOLDER_ID));
  });

  it("returns an empty submissions list with a note when nobody has submitted yet", async () => {
    const { call } = setup((path) => {
      if (path.endsWith("/dropbox/folders/")) return [folder];
      if (path.endsWith("/submissions/")) return [];
      throw notFound();
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID });
    const parsed = body(result);
    expect(parsed.submissions).toEqual([]);
    expect(parsed.note).toBe("No submissions found for this dropbox folder.");
  });

  it("defaults activeOnly to false, returning graded submissions too", async () => {
    const { call } = setup((path) => {
      if (path.endsWith("/dropbox/folders/")) return [folder];
      if (path.endsWith("/submissions/")) {
        return [submission({ Id: 1, SubmittedBy: { Identifier: "501", DisplayName: "Graded" } })];
      }
      if (path.includes("/feedback/user/501")) {
        return { Score: 90, Feedback: { Text: "Nice work", Html: "" }, IsGraded: true };
      }
      throw notFound();
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID });
    const parsed = body(result);
    expect(parsed.activeOnly).toBe(false);
    expect(parsed.submissions.map((s: any) => s.userId)).toEqual(["501"]);
  });

  it("caps returned submissions at limit and reports truncation", async () => {
    const subs = [1, 2, 3].map((n) =>
      submission({ Id: n, SubmittedBy: { Identifier: String(500 + n), DisplayName: `S${n}` } })
    );
    const { call } = setup((path) => {
      if (path.endsWith("/dropbox/folders/")) return [folder];
      if (path.endsWith("/submissions/")) return subs;
      throw notFound();
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, limit: 2 });
    const parsed = body(result);
    expect(parsed.totalSubmissions).toBe(3);
    expect(parsed.returnedSubmissions).toBe(2);
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toContain("Showing 2 of 3");
    expect(parsed.submissions).toHaveLength(2);
  });

  it("does not report truncation when total is within limit", async () => {
    const { call } = setup((path) => {
      if (path.endsWith("/dropbox/folders/")) return [folder];
      if (path.endsWith("/submissions/")) return [submission()];
      throw notFound();
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, limit: 50 });
    const parsed = body(result);
    expect(parsed.truncated).toBe(false);
    expect(parsed.note).toBeUndefined();
  });

  it("fetches feedback only for the kept (post-limit) slice, not the truncated tail", async () => {
    const subs = [1, 2, 3].map((n) =>
      submission({ Id: n, SubmittedBy: { Identifier: String(500 + n), DisplayName: `S${n}` } })
    );
    const feedbackRequests: string[] = [];
    const { call } = setup((path) => {
      if (path.endsWith("/dropbox/folders/")) return [folder];
      if (path.endsWith("/submissions/")) return subs;
      if (path.includes("/feedback/user/")) {
        feedbackRequests.push(path);
        throw notFound();
      }
      throw notFound();
    });

    await call({ courseId: COURSE_ID, folderId: FOLDER_ID, limit: 2 });
    expect(feedbackRequests).toHaveLength(2);
    expect(feedbackRequests.some((p) => p.includes("/feedback/user/503"))).toBe(false);
  });

  it("activeOnly filters out submissions already graded", async () => {
    const { call } = setup((path) => {
      if (path.endsWith("/dropbox/folders/")) return [folder];
      if (path.endsWith("/submissions/")) {
        return [submission({ Id: 1, SubmittedBy: { Identifier: "501", DisplayName: "Graded" } }),
          submission({ Id: 2, SubmittedBy: { Identifier: "502", DisplayName: "Ungraded" } })];
      }
      if (path.includes("/feedback/user/501")) {
        return { Score: 90, Feedback: { Text: "Nice work", Html: "" }, IsGraded: true };
      }
      throw notFound(); // no feedback yet for 502
    });

    const result = await call({ courseId: COURSE_ID, folderId: FOLDER_ID, activeOnly: true });
    const parsed = body(result);
    expect(parsed.submissions.map((s: any) => s.userId)).toEqual(["502"]);
    expect(parsed.totalSubmissions).toBe(2);
    expect(parsed.returnedSubmissions).toBe(1);
  });
});
