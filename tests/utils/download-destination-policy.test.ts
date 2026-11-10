import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import { secureDownload, secureStreamDownload } from "../../src/utils/download-helpers.js";
import { DownloadError } from "../../src/utils/download-errors.js";
import { registerDownloadDropboxSubmissionFile } from "../../src/tools/download-dropbox-submission-file.js";
import { registerGetSyllabus } from "../../src/tools/get-syllabus.js";
import { sanitizeError } from "../../src/tools/tool-helpers.js";

/**
 * Every tool that writes to disk goes through these helpers, so the protected
 * destination rule lives here and a new tool cannot forget it.
 */
const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64)]);
const stream = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(pdf)); c.close(); } });
const places: Array<[string, () => string]> = [
  ["the home directory", () => os.homedir()],
  ["a hidden folder in home", () => `${os.homedir()}/.kube`],
  ["a system folder", () => (process.platform === "win32" ? "C:\\Windows" : "/etc")],
];

describe("shared download helpers refuse protected destinations", () => {
  it.each(places)("secureDownload refuses %s", async (_n, dir) => {
    const error = await secureDownload({ targetDir: dir(), filename: "a.pdf", data: pdf }).catch((e) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).kind).toBe("forbiddenDestination");
  });

  it.each(places)("secureStreamDownload refuses %s", async (_n, dir) => {
    const error = await secureStreamDownload({ targetDir: dir(), filename: "a.pdf", body: stream(), maxBytes: 1e6 }).catch((e) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).kind).toBe("forbiddenDestination");
  });

  it("explains it to the user with a folder to choose instead", () => {
    const text = (sanitizeError(new DownloadError("forbiddenDestination", "x")).content[0] as { text: string }).text;
    expect(text).toContain("~/Documents/Brightspace");
  });
});

describe("tools that write to disk refuse a protected downloadPath before any request", () => {
  it.each(places)("download_dropbox_submission_file refuses %s", async (_n, dir) => {
    const client = { le: (_i: number, p: string) => p, get: vi.fn(), getRaw: vi.fn() };
    let handler: any;
    registerDownloadDropboxSubmissionFile({ registerTool: (_a: string, _b: unknown, f: unknown) => { handler = f; } } as never, client as never);
    const response = await handler({ courseId: 1, folderId: 2, submissionId: 3, fileId: 4, downloadPath: dir() });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/Cannot save into/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it.each(places)("get_syllabus refuses %s", async (_n, dir) => {
    const client = { le: (_i: number, p: string) => p, get: vi.fn(), getRaw: vi.fn() };
    let handler: any;
    registerGetSyllabus({ registerTool: (_a: string, _b: unknown, f: unknown) => { handler = f; } } as never, client as never);
    const response = await handler({ courseId: 1, downloadPath: dir() });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/Cannot save into/);
    expect(client.get).not.toHaveBeenCalled();
  });
});
