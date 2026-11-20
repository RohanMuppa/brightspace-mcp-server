import { describe, it, expect } from "vitest";
import { flattenDropboxSubmissions } from "../../src/utils/dropbox-submissions.js";

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
