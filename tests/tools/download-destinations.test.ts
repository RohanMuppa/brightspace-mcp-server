import { describe, expect, it } from "vitest";
import { DownloadDropboxSubmissionFileSchema, DownloadFileSchema, GetSyllabusSchema } from "../../src/tools/schemas.js";

/**
 * Every tool that saves to disk refuses a downloadPath that does not exist
 * rather than creating it (#333), so each one says so where a client reads
 * the parameter.
 */
describe("downloadPath descriptions", () => {
  it.each([
    ["download_file", DownloadFileSchema],
    ["get_syllabus", GetSyllabusSchema],
    ["download_dropbox_submission_file", DownloadDropboxSubmissionFileSchema],
  ])("%s says the directory must already exist", (_name, schema) => {
    expect(schema.shape.downloadPath.description).toMatch(/must already exist; it is not created for you/);
  });
});

describe("download_file refuses protected destinations", () => {
  it("refuses the home directory and a credential folder, before any request", async () => {
    const os = await import("node:os");
    const { registerDownloadFile } = await import("../../src/tools/download-file.js");
    const { vi } = await import("vitest");
    const client = { le: (_i: number, p: string) => p, getRaw: vi.fn(), get: vi.fn() };
    let handler: any;
    registerDownloadFile({ registerTool: (_n: string, _m: unknown, f: unknown) => { handler = f; } } as never, client as never);
    for (const dir of [os.homedir(), "/etc", "/"]) {
      if (dir === "/etc" && process.platform === "win32") continue;
      const response = await handler({ courseId: 1, topicId: 2, downloadPath: dir });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toMatch(/Cannot save into/);
    }
    expect(client.getRaw).not.toHaveBeenCalled();
  });
});
