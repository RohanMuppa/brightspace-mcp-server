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
