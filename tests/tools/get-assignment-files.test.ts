import { describe, it, expect, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import { registerGetAssignmentFiles, fileKind } from "../../src/tools/get-assignment-files.js";

/**
 * Reading the spec document attached to an assignment was the one student
 * workflow with no tool at all: instructions text was surfaced, the attached
 * PDF or DOCX never was.
 *
 * Shapes here match what a live Purdue course returned: attachments embedded
 * in the folder object as { FileId, FileName, Size }, and a per-file download
 * that answers with the real bytes and content type.
 */

const BASE = "https://brightspace.example.edu";
const COURSE = 101;

const attachment = (fileId: number, fileName: string, size = 1024) => ({
  FileId: fileId,
  FileName: fileName,
  Size: size,
});

const folder = (
  id: number,
  name: string,
  attachments: unknown[] = [],
  extra: Record<string, unknown> = {}
) => ({
  Id: id,
  Name: name,
  DueDate: "2026-09-30T03:59:00.000Z",
  IsHidden: false,
  Attachments: attachments,
  ...extra,
});

/** A minimal but genuine DOCX: one deflated word/document.xml in a real zip. */
function docxBuffer(text: string): Buffer {
  const xml = `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  const content = Buffer.from(xml, "utf-8");
  const stored = deflateRawSync(content);
  const name = Buffer.from("word/document.xml", "utf-8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(stored.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localBlock = Buffer.concat([local, name, stored]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(stored.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralBlock = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

interface Setup {
  folders: unknown;
  file?: Buffer | (() => never);
}

function setup({ folders, file }: Setup) {
  const requested: string[] = [];
  const rawRequested: string[] = [];

  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return folders;
    }),
    getRaw: vi.fn(async (path: string) => {
      rawRequested.push(path);
      if (typeof file === "function") file();
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => (file as Buffer).buffer.slice(
          (file as Buffer).byteOffset,
          (file as Buffer).byteOffset + (file as Buffer).byteLength
        ),
      };
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetAssignmentFiles(server as any, apiClient as any, BASE);
  return { call: (args: unknown) => handler!(args), requested, rawRequested, apiClient };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe("fileKind", () => {
  it("maps the extensions that matter and defaults to other", () => {
    expect(fileKind("spec.pdf")).toBe("pdf");
    expect(fileKind("Lab4.DOCX")).toBe("docx");
    expect(fileKind("data.xlsx")).toBe("xlsx");
    expect(fileKind("deck.pptx")).toBe("pptx");
    expect(fileKind("diagram.png")).toBe("image");
    expect(fileKind("notes.md")).toBe("text");
    expect(fileKind("archive.zip")).toBe("other");
    expect(fileKind("noextension")).toBe("other");
  });
});

describe("get_assignment_files discovery", () => {
  it("lists only assignments that have attachments, and downloads nothing", async () => {
    const { call, rawRequested } = setup({
      folders: [
        folder(1, "Lab 4", [attachment(11, "spec.pdf", 2048)]),
        folder(2, "Reading", []),
        folder(3, "Project", [attachment(31, "starter.xlsx"), attachment(32, "rubric.docx")]),
      ],
    });

    const payload = parse(await call({ courseId: COURSE }));

    expect(payload.assignments).toHaveLength(2);
    expect(payload.assignments[0]).toMatchObject({
      folderId: 1,
      folderName: "Lab 4",
      url: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=1&grpid=0&ou=${COURSE}`,
    });
    expect(payload.assignments[0].attachments[0]).toEqual({
      fileId: 11,
      fileName: "spec.pdf",
      size: 2048,
      kind: "pdf",
    });
    expect(payload.assignments[1].attachments.map((a: any) => a.kind)).toEqual(["xlsx", "docx"]);
    expect(rawRequested).toEqual([]);
  });

  it("excludes hidden folders", async () => {
    const { call } = setup({
      folders: [
        folder(1, "Visible", [attachment(11, "a.pdf")]),
        folder(2, "Hidden", [attachment(21, "b.pdf")], { IsHidden: true }),
      ],
    });

    const payload = parse(await call({ courseId: COURSE }));
    expect(payload.assignments.map((a: any) => a.folderId)).toEqual([1]);
  });

  it("accepts the paged envelope as well as a bare array", async () => {
    const { call } = setup({
      folders: { Objects: [folder(1, "Lab 4", [attachment(11, "spec.pdf")])] },
    });

    const payload = parse(await call({ courseId: COURSE }));
    expect(payload.assignments).toHaveLength(1);
  });

  it("says so plainly when no assignment has a file", async () => {
    const { call } = setup({ folders: [folder(1, "Reading", [])] });

    const payload = parse(await call({ courseId: COURSE }));
    expect(payload.assignments).toEqual([]);
    expect(payload.note).toMatch(/no assignment/i);
  });

  it("narrows to one folder when folderId is given", async () => {
    const { call } = setup({
      folders: [
        folder(1, "Lab 4", [attachment(11, "spec.pdf")]),
        folder(2, "Project", [attachment(21, "rubric.docx")]),
      ],
    });

    const payload = parse(await call({ courseId: COURSE, folderId: 2 }));
    expect(payload.assignments).toHaveLength(1);
    expect(payload.assignments[0].folderName).toBe("Project");
  });
});

describe("get_assignment_files reading one file", () => {
  it("returns the text of a DOCX attachment", async () => {
    const { call, rawRequested } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "spec.docx")])],
      file: docxBuffer("Build a parser and submit the source"),
    });

    const payload = parse(await call({ courseId: COURSE, folderId: 1, fileId: 11 }));

    expect(payload.file.text).toContain("Build a parser");
    expect(payload.file.truncated).toBe(false);
    expect(payload.file.kind).toBe("docx");
    expect(rawRequested).toEqual(["/d2l/api/le/1.0/101/dropbox/folders/1/attachments/11"]);
  });

  it("truncates at maxChars and says it did", async () => {
    const { call } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "spec.docx")])],
      file: docxBuffer("x".repeat(500)),
    });

    const payload = parse(
      await call({ courseId: COURSE, folderId: 1, fileId: 11, maxChars: 50 })
    );

    expect(payload.file.text).toHaveLength(50);
    expect(payload.file.truncated).toBe(true);
  });

  it("reads plain text directly", async () => {
    const { call } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "readme.txt")])],
      file: Buffer.from("Answer all six questions.", "utf-8"),
    });

    const payload = parse(await call({ courseId: COURSE, folderId: 1, fileId: 11 }));
    expect(payload.file.text).toBe("Answer all six questions.");
  });

  it("reports a type it cannot read instead of failing", async () => {
    const { call } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "diagram.png")])],
      file: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });

    const payload = parse(await call({ courseId: COURSE, folderId: 1, fileId: 11 }));
    expect(payload.file.text).toBeNull();
    expect(payload.file.note).toMatch(/download_file/);
  });

  it("skips the download when extractText is false", async () => {
    const { call, rawRequested } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "spec.docx")])],
      file: docxBuffer("unused"),
    });

    const payload = parse(
      await call({ courseId: COURSE, folderId: 1, fileId: 11, extractText: false })
    );

    expect(payload.file.text).toBeNull();
    expect(rawRequested).toEqual([]);
  });

  it("names the available files when the fileId is wrong", async () => {
    const { call } = setup({
      folders: [folder(1, "Lab 4", [attachment(11, "spec.pdf")])],
      file: Buffer.alloc(0),
    });

    const payload = parse(await call({ courseId: COURSE, folderId: 1, fileId: 999 }));
    expect(payload.error).toMatch(/no attachment with id 999/i);
    expect(payload.available[0].fileId).toBe(11);
  });

  it("reports a missing assignment clearly", async () => {
    const { call } = setup({ folders: [folder(1, "Lab 4", [])] });

    const payload = parse(await call({ courseId: COURSE, folderId: 42 }));
    expect(payload.error).toMatch(/no visible assignment with id 42/i);
  });

  it("requires folderId when fileId is given", async () => {
    const { call } = setup({ folders: [folder(1, "Lab 4", [attachment(11, "a.pdf")])] });

    const payload = parse(await call({ courseId: COURSE, fileId: 11 }));
    expect(payload.error).toMatch(/folderId is required/i);
  });
});
