import { describe, it, expect, vi } from "vitest";
import { registerGetDropboxFolders } from "../../src/tools/get-dropbox-folders.js";
import { ApiError } from "../../src/api/errors.js";

const COURSE_ID = 101;

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

  registerGetDropboxFolders(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), apiClient };
}

const body = (result: any) => JSON.parse(result.content[0].text);

const folder = (overrides: Record<string, unknown> = {}) => ({
  Id: 55,
  CategoryId: null,
  Name: "HW 1",
  StartDate: null,
  EndDate: null,
  DueDate: "2026-09-10T00:00:00.000Z",
  IsHidden: false,
  GroupTypeId: null,
  SubmissionType: 0,
  Assessment: { ScoreDenominator: 100, Rubrics: [{ RubricId: 9, Name: "Lab rubric" }] },
  ...overrides,
});

describe("get_dropbox_folders", () => {
  it("maps a bare-array response", async () => {
    const { call } = setup(() => [folder()]);
    const result = await call({ courseId: COURSE_ID });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.folders).toHaveLength(1);
    expect(parsed.folders[0]).toMatchObject({
      folderId: 55,
      name: "HW 1",
      hasRubrics: true,
      submissionType: "file",
      maxScore: 100,
    });
  });

  it("maps an {Objects: []} wrapped response identically", async () => {
    const { call } = setup(() => ({ Objects: [folder()] }));
    const result = await call({ courseId: COURSE_ID });

    const parsed = body(result);
    expect(parsed.folders).toHaveLength(1);
    expect(parsed.folders[0].folderId).toBe(55);
  });

  it("calls a folder with no GroupTypeId an individual folder (#240)", async () => {
    const individual = folder();
    delete (individual as Record<string, unknown>).GroupTypeId;
    const { call } = setup(() => [individual, folder({ Id: 56, GroupTypeId: 7 })]);
    const result = await call({ courseId: COURSE_ID });

    const parsed = body(result);
    expect(parsed.folders.map((f: any) => [f.folderId, f.isGroup])).toEqual([
      [55, false],
      [56, true],
    ]);
  });

  // Students can read the folder list, so a 403 must not blame a missing staff role (#437).
  it("explains a 403 as enrolment or a hidden Assignments tool, not a staff-only read", async () => {
    const { call } = setup(forbidden);
    const result = await call({ courseId: COURSE_ID });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).not.toContain("Instructor or TA");
    expect(text).toContain("refused to list this course's assignment folders");
    expect(text).toContain("not enrolled");
    expect(text).toContain("get_my_courses");
  });

  it("returns an empty list with a note on 404, not a failure", async () => {
    const { call } = setup(notFound);
    const result = await call({ courseId: COURSE_ID });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.folders).toEqual([]);
    expect(parsed.note).toBeTruthy();
  });

  it("returns an empty list with a note when the course genuinely has none", async () => {
    const { call } = setup(() => []);
    const result = await call({ courseId: COURSE_ID });

    expect(result.isError).toBeUndefined();
    const parsed = body(result);
    expect(parsed.folders).toEqual([]);
    expect(parsed.note).toBe("No dropbox folders found for this course.");
  });
});
