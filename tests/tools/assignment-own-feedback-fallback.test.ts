import { describe, it, expect } from "vitest";
import { fetchCourseAssignments } from "../../src/tools/get-assignments.js";

const GRADED = {
  Score: 9, IsGraded: true, Feedback: { Text: "Nice work", Html: "<p>Nice <b>work</b></p>" }, RubricAssessments: [],
};
const SUB = { Id: 1, SubmittedBy: { Identifier: "7", DisplayName: "Me" }, SubmissionDate: "2026-10-01T00:00:00Z", Comment: null, Files: [] };

interface Opts {
  myFeedback?: unknown; // thrown when it is a number (HTTP status)
  submissions?: unknown;
  userFeedback?: unknown; // thrown when it is a number (HTTP status)
  groupTypeId?: number | null;
}

function client(opts: Opts) {
  const requested: string[] = [];
  const res = (v: unknown, path: string) => {
    if (typeof v === "number") throw Object.assign(new Error("API error " + path), { status: v });
    return v;
  };
  return {
    requested,
    le: (course: number, path: string) => `/d2l/api/le/1.0/${course}${path}`,
    lp: (path: string) => `/d2l/api/lp/1.0${path}`,
    get: async (path: string) => {
      requested.push(path);
      if (path.endsWith("/dropbox/folders/")) return [{ Id: 55, Name: "Mini-Assignment #1", IsHidden: false, GroupTypeId: opts.groupTypeId ?? null }];
      if (path.includes("/feedback/myFeedback/")) return res(opts.myFeedback ?? 404, path);
      if (path.includes("/submissions/mysubmissions/")) return res(opts.submissions ?? [], path);
      if (path.endsWith("/users/whoami")) return { Identifier: "7" };
      if (path.includes("/feedback/user/7")) return res(opts.userFeedback ?? 404, path);
      return [];
    },
  };
}

describe("get_assignments: student's own feedback falls back to documented routes", () => {
  it("reads Feedback embedded in a flat mysubmissions entry when myFeedback has none", async () => {
    const c = client({ submissions: [{ ...SUB, Feedback: GRADED }] });
    const [a] = await fetchCourseAssignments(c as any, 101, "https://x.example.edu");
    expect(a).toMatchObject({ feedbackStatus: "retrieved", feedbackSource: "submission",
      feedback: { score: 9, feedback: "Nice **work**" }, feedbackCommentsStatus: "retrieved" });
    expect(a.feedbackStatusNote).toBeUndefined();
    expect(c.requested.some((p) => p.includes("/feedback/user/"))).toBe(false);
  });

  it("reads Feedback from an EntityDropbox-shaped mysubmissions answer and keeps the submission fields", async () => {
    const c = client({ submissions: [{ Entity: { EntityId: 7, EntityType: "User" }, Status: 3, Feedback: GRADED, Submissions: [SUB] }] });
    const [a] = await fetchCourseAssignments(c as any, 101);
    expect(a).toMatchObject({ submissionStatus: "submitted", feedbackSource: "submission", feedback: { score: 9 } });
    expect(a.submission.submittedDate).toBe("2026-10-01T00:00:00Z");
  });

  it("asks the documented feedback/user/{me} route when nothing is embedded", async () => {
    const c = client({ submissions: [SUB], userFeedback: GRADED });
    const [a] = await fetchCourseAssignments(c as any, 101);
    expect(a).toMatchObject({ feedbackStatus: "retrieved", feedbackSource: "user", feedback: { score: 9, feedback: "Nice **work**" } });
    expect(c.requested.some((p) => p.endsWith("/dropbox/folders/55/feedback/user/7"))).toBe(true);
  });

  it("ignores draft (ungraded) feedback, which a student has not been given", async () => {
    const c = client({ submissions: [{ ...SUB, Feedback: { ...GRADED, IsGraded: false } }], userFeedback: 404 });
    const [a] = await fetchCourseAssignments(c as any, 101);
    expect(a).toMatchObject({ feedbackStatus: "unavailable", feedback: null });
    expect(a.feedbackSource).toBeUndefined();
  });

  it("keeps the original status when every route comes back empty or refused", async () => {
    const c = client({ myFeedback: 403, submissions: [SUB], userFeedback: 403 });
    const [a] = await fetchCourseAssignments(c as any, 101);
    expect(a).toMatchObject({ feedbackStatus: "restricted", feedback: null });
    expect(a.feedbackStatusNote).toContain("do not interpret null as no feedback");
  });

  it("makes no extra requests when myFeedback already answered", async () => {
    const c = client({ myFeedback: { Score: 4, Feedback: { Text: "ok" } }, submissions: [SUB] });
    const [a] = await fetchCourseAssignments(c as any, 101);
    expect(a).toMatchObject({ feedbackStatus: "retrieved", feedbackSource: "myFeedback" });
    expect(c.requested.some((p) => p.includes("/feedback/user/") || p.endsWith("/users/whoami"))).toBe(false);
  });

  it("makes no extra requests when nothing was submitted", async () => {
    const c = client({ submissions: 404 });
    const [a] = await fetchCourseAssignments(c as any, 101);
    expect(a).toMatchObject({ feedbackStatus: "unavailable", feedback: null });
    expect(c.requested.some((p) => p.includes("/feedback/user/") || p.endsWith("/users/whoami"))).toBe(false);
  });

  it("does not ask the per-user route for a group folder, but still uses embedded feedback", async () => {
    const c = client({ groupTypeId: 3, submissions: [{ ...SUB, Feedback: GRADED }] });
    const [a] = await fetchCourseAssignments(c as any, 101);
    expect(a.feedbackSource).toBe("submission");
    const c2 = client({ groupTypeId: 3, submissions: [SUB], userFeedback: GRADED });
    const [b] = await fetchCourseAssignments(c2 as any, 101);
    expect(b.feedback).toBeNull();
    expect(c2.requested.some((p) => p.includes("/feedback/user/"))).toBe(false);
  });
});
