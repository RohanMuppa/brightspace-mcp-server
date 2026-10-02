import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerDownloadDropboxSubmissionFile } from "../../src/tools/download-dropbox-submission-file.js";
import { ApiError } from "../../src/api/errors.js";
import { MAX_FILE_SIZE } from "../../src/utils/file-validator.js";

const COURSE_ID = 101;
const FOLDER_ID = 55;
const SUBMISSION_ID = 9001;
const FILE_ID = 1;

/** A buffer file-type recognises as a PDF, so the allowlist lets it through. */
function pdfBuffer(size = 512): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(size)]);
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const submissionsList = (fileSize = 512) => [
  {
    Id: SUBMISSION_ID,
    Files: [{ FileId: FILE_ID, FileName: "hw1.pdf", Size: fileSize }],
  },
];

interface Setup {
  submissionsResult?: unknown | (() => never);
  rawResult?: unknown | (() => never);
  body?: Buffer;
}

function setup({ submissionsResult = submissionsList(), rawResult, body = pdfBuffer() }: Setup) {
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (_p: string) => {
      if (typeof submissionsResult === "function") return (submissionsResult as () => never)();
      return submissionsResult;
    }),
    getRaw: vi.fn(async (_p: string) => {
      if (typeof rawResult === "function") return (rawResult as () => never)();
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Length": String(body.byteLength) }),
        arrayBuffer: async () => toArrayBuffer(body),
      };
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerDownloadDropboxSubmissionFile(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args) };
}

const parse = (result: any) => JSON.parse(result.content[0].text);
const textOf = (result: any) => result.content.map((c: any) => c.text ?? "").join("\n");

let root: string;
let targetDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "download-dropbox-"));
  targetDir = path.join(root, "a", "b");
  await fs.mkdir(targetDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("download_dropbox_submission_file", () => {
  it("downloads the file through secureDownload (path containment, magic-byte typing)", async () => {
    const { call } = setup({});
    const result = await call({
      courseId: COURSE_ID,
      folderId: FOLDER_ID,
      submissionId: SUBMISSION_ID,
      fileId: FILE_ID,
      downloadPath: targetDir,
    });

    expect(result.isError).toBeUndefined();
    const parsed = parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.mimeType).toBe("application/pdf");
    expect(await fs.readFile(parsed.filePath)).toHaveLength(pdfBuffer().byteLength);
  });

  it("refuses a file whose reported size exceeds MAX_FILE_SIZE before downloading anything", async () => {
    const { call } = setup({ submissionsResult: submissionsList(MAX_FILE_SIZE + 1) });
    const result = await call({
      courseId: COURSE_ID,
      folderId: FOLDER_ID,
      submissionId: SUBMISSION_ID,
      fileId: FILE_ID,
      downloadPath: targetDir,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too large");
    expect(await fs.readdir(targetDir)).toEqual([]);
  });

  it("refuses a file whose actual downloaded size exceeds MAX_FILE_SIZE even when reported size lied", async () => {
    const oversized = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(MAX_FILE_SIZE)]);
    const { call } = setup({ body: oversized });
    const result = await call({
      courseId: COURSE_ID,
      folderId: FOLDER_ID,
      submissionId: SUBMISSION_ID,
      fileId: FILE_ID,
      downloadPath: targetDir,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too large");
  });

  it("refuses a file type that is not on the allowlist, via secureDownload's magic-byte check", async () => {
    // No recognizable magic-byte signature, and a NUL byte rules out the
    // plain-text fallback too, so validateFileType has nothing to allow.
    const unknownBinary = Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x03]), Buffer.alloc(64, 0xff)]);
    const { call } = setup({ body: unknownBinary });
    const result = await call({
      courseId: COURSE_ID,
      folderId: FOLDER_ID,
      submissionId: SUBMISSION_ID,
      fileId: FILE_ID,
      downloadPath: targetDir,
      customFilename: "totally-safe.pdf",
    });

    expect(result.isError).toBe(true);
    expect(await fs.readdir(targetDir)).toEqual([]);
  });

  it("returns a clear instructor/TA note on 403 while listing submissions, not a generic error", async () => {
    const { call } = setup({
      submissionsResult: () => { throw new ApiError(403, "/submissions/", "Forbidden"); },
    });
    const result = await call({
      courseId: COURSE_ID,
      folderId: FOLDER_ID,
      submissionId: SUBMISSION_ID,
      fileId: FILE_ID,
      downloadPath: targetDir,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Instructor or TA access required for this course");
  });

  it("reports the folder as not found on 404 while listing submissions", async () => {
    const { call } = setup({
      submissionsResult: () => { throw new ApiError(404, "/submissions/", "Not Found"); },
    });
    const result = await call({
      courseId: COURSE_ID,
      folderId: FOLDER_ID,
      submissionId: SUBMISSION_ID,
      fileId: FILE_ID,
      downloadPath: targetDir,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`Folder ${FOLDER_ID} not found`);
  });

  it("rejects a relative downloadPath", async () => {
    const { call } = setup({});
    const result = await call({
      courseId: COURSE_ID,
      folderId: FOLDER_ID,
      submissionId: SUBMISSION_ID,
      fileId: FILE_ID,
      downloadPath: "relative/path",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("absolute path");
  });

  it("names the unknown file id and lists what is actually available", async () => {
    const { call } = setup({});
    const result = await call({
      courseId: COURSE_ID,
      folderId: FOLDER_ID,
      submissionId: SUBMISSION_ID,
      fileId: 999,
      downloadPath: targetDir,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("hw1.pdf");
  });
});
