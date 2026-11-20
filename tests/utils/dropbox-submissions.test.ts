import { describe, it, expect } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import { flattenDropboxSubmissions, submissionFileUrl, readMyFeedback, readMySubmissions } from "../../src/utils/dropbox-submissions.js";

describe("flattenDropboxSubmissions", () => {
  const sub = (Id: number) => ({ Id, Files: [] as unknown[] });

  it("passes a flat list through", () => {
    expect(flattenDropboxSubmissions([sub(1), sub(2)])).toEqual([sub(1), sub(2)]);
  });

  it("unwraps EntityDropbox entries, in order", () => {
    const raw = [{ Entity: {}, Submissions: [sub(1), sub(2)] }, { Entity: {}, Submissions: [sub(3)] }];
    expect(flattenDropboxSubmissions(raw as any).map((s: any) => s.Id)).toEqual([1, 2, 3]);
  });

  it("yields nothing for an entity whose Submissions is empty", () => {
    expect(flattenDropboxSubmissions([{ Entity: {}, Submissions: [] }] as any)).toEqual([]);
  });

  it("reads an { Objects } wrapper, null and undefined", () => {
    expect(flattenDropboxSubmissions({ Objects: [sub(1)] })).toEqual([sub(1)]);
    expect(flattenDropboxSubmissions(null)).toEqual([]);
    expect(flattenDropboxSubmissions(undefined)).toEqual([]);
  });
});

describe("flattenDropboxSubmissions with a null entry", () => {
  it("skips it instead of throwing", () => {
    expect(flattenDropboxSubmissions([null as never, { Id: 1 }])).toEqual([{ Id: 1 }]);
  });
});

const authError = () => new ApiError(401, "/x", "Session expired");

function fakeClient(routes: Record<string, unknown>) {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    le: (course: number, p: string) => `/le/${course}${p}`,
    lp: (p: string) => `/lp${p}`,
    get: async (p: string, options?: unknown) => {
      calls.push([p, options]);
      const hit = Object.entries(routes).find(([suffix]) => p.endsWith(suffix));
      if (!hit) throw new ApiError(404, p, "not found");
      if (hit[1] instanceof Error) throw hit[1];
      return hit[1];
    },
  } as any;
}

describe("readMySubmissions", () => {
  it("reads a flat list", async () => {
    const client = fakeClient({ "/dropbox/folders/5/submissions/mysubmissions/": [{ Id: 1, Files: [] }] });
    expect(await readMySubmissions(client, 7, 5)).toEqual({ known: true, submissions: [{ Id: 1, Files: [] }], embeddedFeedback: null });
  });

  it("unwraps EntityDropbox entries and returns the embedded feedback", async () => {
    const client = fakeClient({
      "/mysubmissions/": [{ Entity: {}, Feedback: { Score: 3 }, Submissions: [{ Id: 1 }, { Id: 2 }] }],
    });
    const out = await readMySubmissions(client, 7, 5);
    expect(out.submissions.map((s: any) => s.Id)).toEqual([1, 2]);
    expect(out.embeddedFeedback).toEqual({ Score: 3 });
  });

  it("reads an { Objects } wrapper", async () => {
    const client = fakeClient({ "/mysubmissions/": { Objects: [{ Id: 4 }] } });
    expect((await readMySubmissions(client, 7, 5)).submissions).toEqual([{ Id: 4 }]);
  });

  it("treats a 404 as known: nothing submitted", async () => {
    const out = await readMySubmissions(fakeClient({}), 7, 5);
    expect(out).toMatchObject({ known: true, submissions: [] });
    expect(out.status).toBeUndefined();
  });

  it("treats a 403 as unknown and keeps the status", async () => {
    const client = fakeClient({ "/mysubmissions/": new ApiError(403, "/x", "no") });
    expect(await readMySubmissions(client, 7, 5)).toMatchObject({ known: false, status: 403, submissions: [] });
  });

  it("treats a failure with no status as unknown with a null status", async () => {
    const client = fakeClient({ "/mysubmissions/": new Error("boom") });
    expect(await readMySubmissions(client, 7, 5)).toMatchObject({ known: false, status: null });
  });

  it("rethrows a lost sign-in", async () => {
    const client = fakeClient({ "/mysubmissions/": authError() });
    await expect(readMySubmissions(client, 7, 5)).rejects.toMatchObject({ status: 401 });
  });

  it("passes the request options through", async () => {
    const client = fakeClient({ "/mysubmissions/": [] });
    await readMySubmissions(client, 7, 5, { ttl: 123 });
    expect(client.calls[0][1]).toEqual({ ttl: 123 });
  });
});

describe("readMyFeedback", () => {
  const none = { submissions: [] as any[], embeddedFeedback: null };
  const folder = { Id: 5, GroupTypeId: null };

  it("retrieves myFeedback", async () => {
    const client = fakeClient({ "/feedback/myFeedback/": { Score: 2 } });
    expect(await readMyFeedback(client, 7, folder, none)).toEqual({ feedback: { Score: 2 }, status: "retrieved", source: "myFeedback" });
  });

  it.each([[403, "restricted"], [404, "unavailable"], [500, "error"]])("maps %s to %s", async (code, expected) => {
    const client = fakeClient({ "/feedback/myFeedback/": new ApiError(code, "/x", "no") });
    expect(await readMyFeedback(client, 7, folder, none)).toMatchObject({ feedback: null, status: expected, source: null });
  });

  it("a null answer is unavailable", async () => {
    expect(await readMyFeedback(fakeClient({ "/feedback/myFeedback/": null }), 7, folder, none)).toMatchObject({ status: "unavailable" });
  });

  it("rethrows a lost sign-in", async () => {
    await expect(readMyFeedback(fakeClient({ "/feedback/myFeedback/": authError() }), 7, folder, none)).rejects.toMatchObject({ status: 401 });
  });

  it("falls back to embedded released feedback, but not to a draft", async () => {
    const released = { submissions: [{ Id: 1 }] as any[], embeddedFeedback: { IsGraded: true, Score: 9 } as any };
    expect(await readMyFeedback(fakeClient({}), 7, folder, released)).toMatchObject({ status: "retrieved", source: "submission", feedback: { Score: 9 } });
    const draft = { submissions: [{ Id: 1 }] as any[], embeddedFeedback: { IsGraded: false, Score: 9 } as any };
    expect(await readMyFeedback(fakeClient({}), 7, folder, draft)).toMatchObject({ feedback: null, status: "unavailable" });
  });

  it("falls back to the user route for an individual folder", async () => {
    const client = fakeClient({ "/users/whoami": { Identifier: 5 }, "/feedback/user/5": { IsGraded: true, Score: 6 } });
    expect(await readMyFeedback(client, 7, folder, { submissions: [{ Id: 1 }] as any[], embeddedFeedback: null }))
      .toMatchObject({ status: "retrieved", source: "user", feedback: { Score: 6 } });
  });

  it("never takes the user route for a group folder, and says it skipped it", async () => {
    const client = fakeClient({ "/users/whoami": { Identifier: 5 }, "/feedback/user/5": { IsGraded: true, Score: 6 } });
    const out = await readMyFeedback(client, 7, { Id: 5, GroupTypeId: 3 }, { submissions: [{ Id: 1 }] as any[], embeddedFeedback: null });
    expect(out).toMatchObject({ feedback: null, status: "unavailable", groupRouteSkipped: true });
    expect(client.calls.some(([p]: [string]) => p.includes("/feedback/user/"))).toBe(false);
  });

  it("a failing user route leaves it unavailable, not an error", async () => {
    const client = fakeClient({ "/users/whoami": new Error("boom") });
    expect(await readMyFeedback(client, 7, folder, { submissions: [{ Id: 1 }] as any[], embeddedFeedback: null })).toMatchObject({ feedback: null, status: "unavailable" });
  });
});

describe("submissionFileUrl", () => {
  it("builds the documented route, with no download suffix", () => {
    expect(submissionFileUrl(fakeClient({}), 7, 5, 3, 11)).toBe("/le/7/dropbox/folders/5/submissions/3/files/11");
  });
});
