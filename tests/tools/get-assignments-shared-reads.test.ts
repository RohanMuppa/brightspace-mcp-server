import { describe, it, expect } from "vitest";
import { fetchCourseAssignments } from "../../src/tools/get-assignments.js";

/** A client answering one folder's submission and feedback routes, each with a value or an error. */
function client(routes: { subs?: unknown; feedback?: unknown; user?: unknown; folder?: Record<string, unknown> }) {
  const answer = (value: unknown) => {
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    le: (course: number, path: string) => `/d2l/api/le/1.0/${course}${path}`,
    lp: (path: string) => `/d2l/api/lp/1.0${path}`,
    get: async (path: string) => {
      if (path.endsWith("/dropbox/folders/")) return [{ Id: 9, Name: "Essay", IsHidden: false, GroupTypeId: null, ...routes.folder }];
      if (path.endsWith("/submissions/mysubmissions/")) return answer(routes.subs ?? new Error("x"));
      if (path.includes("/feedback/myFeedback/")) return answer(routes.feedback ?? null);
      if (path.endsWith("/users/whoami")) return { Identifier: 5 };
      if (path.includes("/feedback/user/5")) return answer(routes.user ?? null);
      return [];
    },
  };
}
const status = (code: number) => Object.assign(new Error("api"), { status: code });
const sub = { Id: 3, SubmittedBy: { Identifier: "5", DisplayName: "A" }, SubmissionDate: "2026-10-02T21:10:00Z", Comment: { Text: "hi", Html: "" }, Files: [{ FileId: 1, FileName: "Essay.docx", Size: 10 }] };

async function read(routes: Parameters<typeof client>[0]) {
  const [a] = await fetchCourseAssignments(client(routes) as any, 1);
  const { submissionStatus, submissionStatusNote, submissionSource, submission, feedback, feedbackStatus, feedbackSource } = a;
  return { submissionStatus, submissionStatusNote, submissionSource, submission, feedback, feedbackStatus, feedbackSource };
}

describe("get_assignments output over the shared submission and feedback reads", () => {
  it("flat submissions, myFeedback retrieved", async () => {
    expect(await read({ subs: [sub], feedback: { Score: 4, Feedback: { Text: "ok", Html: "" } } })).toEqual({
      submissionStatus: "submitted", submissionStatusNote: undefined, submissionSource: undefined,
      submission: { submittedDate: sub.SubmissionDate, files: [{ name: "Essay.docx", size: 10, fileId: 1 }], comment: "hi" },
      feedback: { score: 4, feedback: "ok", rubricAssessments: [] }, feedbackStatus: "retrieved", feedbackSource: "myFeedback",
    });
  });

  it("404 on mysubmissions is not_submitted, and feedback 404 is unavailable", async () => {
    expect(await read({ subs: status(404), feedback: status(404) })).toMatchObject({
      submissionStatus: "not_submitted", submission: null, feedback: null, feedbackStatus: "unavailable", feedbackSource: undefined,
    });
  });

  it("403 on mysubmissions is unknown with the note; 403 feedback is restricted", async () => {
    const out = await read({ subs: status(403), feedback: status(403) });
    expect(out.submissionStatus).toBe("unknown");
    expect(out.submissionStatusNote).toContain("is unknown");
    expect(out).toMatchObject({ submission: null, feedback: null, feedbackStatus: "restricted" });
  });

  it("a 500 on feedback is error", async () => {
    expect(await read({ subs: [], feedback: status(500) })).toMatchObject({ feedbackStatus: "error", feedback: null });
  });

  it("EntityDropbox: embedded feedback is used when myFeedback has none", async () => {
    const entity = [{ Entity: {}, Feedback: { IsGraded: true, Score: 7, Feedback: { Text: "emb", Html: "" } }, Submissions: [sub] }];
    expect(await read({ subs: entity })).toMatchObject({
      submissionStatus: "submitted", feedbackStatus: "retrieved", feedbackSource: "submission",
      feedback: { score: 7, feedback: "emb" },
    });
  });

  it("an ungraded embedded draft is not released; the user route then supplies feedback", async () => {
    const entity = [{ Entity: {}, Feedback: { IsGraded: false, Score: 1, Feedback: null }, Submissions: [sub] }];
    expect(await read({ subs: entity, user: { IsGraded: true, Score: 8, Feedback: { Text: "u", Html: "" } } })).toMatchObject({
      feedbackStatus: "retrieved", feedbackSource: "user", feedback: { score: 8 },
    });
  });

  it("a group folder never takes the student feedback route", async () => {
    expect(await read({ subs: [sub], user: { IsGraded: true, Score: 8 }, folder: { GroupTypeId: 4 } })).toMatchObject({
      feedback: null, feedbackStatus: "unavailable",
    });
  });
});
