import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/utils/update-checker.js", () => ({ getUpdateNotice: vi.fn(() => null) }));

const { getUpdateNotice } = await import("../../src/utils/update-checker.js");
const {
  registerDownloadFile,
  parseContentDispositionFilename,
} = await import("../../src/tools/download-file.js");

/**
 * download_file had no test of its own. Both of the things it gets from the
 * remote side — the Content-Disposition filename and the dropbox submission
 * list — are covered here, because both were wrong.
 */

const COURSE = 101;

/** A buffer file-type recognises as a PDF, so the allowlist lets it through. */
function pdfBuffer(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(512)]);
}

/** The smallest one-page PDF that really renders the given text (mirrors tests/utils/pdf-extractor.test.ts). */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

/** A buffer file-type recognises as a JPEG purely from its header bytes. */
function jpegBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256)]);
}

/**
 * A buffer file-type recognises as a PNG. Unlike JPEG, file-type's PNG
 * detector reads past the signature for a real IHDR chunk (13 bytes, by
 * name) followed by a chunk it can name as IDAT before it trusts the magic
 * bytes alone — the rest of the file can be arbitrary padding to reach
 * `totalSize` since detection returns as soon as it sees the IDAT header.
 */
function pngBuffer(totalSize: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrHeader = Buffer.alloc(8);
  ihdrHeader.writeUInt32BE(13, 0);
  ihdrHeader.write("IHDR", 4, "latin1");
  const ihdrDataAndCrc = Buffer.alloc(13 + 4); // contents unchecked by file-type

  const idatHeader = Buffer.alloc(8);
  idatHeader.writeUInt32BE(0, 0);
  idatHeader.write("IDAT", 4, "latin1");

  const head = Buffer.concat([signature, ihdrHeader, ihdrDataAndCrc, idatHeader]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, totalSize - head.length))]);
}

/**
 * Build a minimal real ZIP archive (stored entries, no compression) so
 * file-type's own zip scanner — not just our in-repo zip-extract.ts reader —
 * recognises it. Mirrors the helper in tests/utils/zip-extract.test.ts.
 */
function buildZip(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf-8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored, no compression
    local.writeUInt32LE(0, 14); // crc, unchecked by either reader
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localBlock = Buffer.concat([local, name, entry.content]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));

    locals.push(localBlock);
    offset += localBlock.length;
  }

  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBlock, eocd]);
}

/**
 * A DOCX file-type will actually identify as
 * application/vnd.openxmlformats-officedocument.wordprocessingml.document:
 * a [Content_Types].xml declaring word/document.xml's content type (the
 * ".main+xml" suffix is how file-type's own detector reads this, matching a
 * real DOCX) plus the document part itself.
 */
function fakeDocxBuffer(text: string): Buffer {
  const contentTypes = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
    "utf-8"
  );
  const documentXml = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    "utf-8"
  );
  return buildZip([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "word/document.xml", content: documentXml },
  ]);
}

/** A plain ZIP with no Office parts — file-type reports it as application/zip. */
function plainZipBuffer(): Buffer {
  return buildZip([{ name: "readme.txt", content: Buffer.from("just a zip, nothing office about it") }]);
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

interface Setup {
  /** Content-Disposition header returned for a content-topic download. */
  disposition?: string;
  /** What GET .../mysubmissions/ answers with. */
  submissions?: unknown;
  /** What GET .../news/(newsId) answers with. */
  newsItem?: unknown;
  /** Content-Length header on the raw download. */
  contentLength?: number;
  body?: Buffer;
}

function setup({ disposition, submissions, newsItem, contentLength, body = pdfBuffer() }: Setup) {
  const rawRequested: string[] = [];

  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (p: string) => (p.includes("/news/") ? newsItem : submissions)),
    getRaw: vi.fn(async (p: string) => {
      rawRequested.push(p);
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          ...(disposition ? { "Content-Disposition": disposition } : {}),
          ...(contentLength !== undefined ? { "Content-Length": String(contentLength) } : {}),
        }),
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

  registerDownloadFile(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), rawRequested };
}

const parse = (result: any) => JSON.parse(result.content[0].text);
const textOf = (result: any) =>
  result.content.map((c: any) => c.text ?? "").join("\n");

let root: string;
let targetDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "download-file-"));
  targetDir = path.join(root, "a", "b");
  await fs.mkdir(targetDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Everything that landed anywhere under root, relative to root. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

describe("parseContentDispositionFilename", () => {
  it("reads quoted, bare and RFC 5987 forms, preferring the extended one", () => {
    expect(parseContentDispositionFilename('attachment; filename="report.pdf"')).toBe(
      "report.pdf"
    );
    expect(parseContentDispositionFilename("attachment; filename=Lecture 7.pdf")).toBe(
      "Lecture 7.pdf"
    );
    expect(
      parseContentDispositionFilename("attachment; filename*=UTF-8''Lecture%207.pdf")
    ).toBe("Lecture 7.pdf");
    expect(
      parseContentDispositionFilename(
        "attachment; filename=\"a.pdf\"; filename*=UTF-8''b.pdf"
      )
    ).toBe("b.pdf");
    expect(parseContentDispositionFilename("inline")).toBeNull();
  });

  // Not a bug in the parser — the point is that it faithfully hands the
  // separators on, so whatever writes the file is the thing that has to be safe.
  it("passes a traversal-shaped name through verbatim", () => {
    expect(parseContentDispositionFilename('attachment; filename="../../pwned.pdf"')).toBe(
      "../../pwned.pdf"
    );
  });
});

describe("download_file: filenames from Brightspace stay inside the download directory", () => {
  it("does not write above the download directory for a traversing Content-Disposition", async () => {
    const { call } = setup({ disposition: 'attachment; filename="../../pwned.pdf"' });

    const result = await call({ courseId: COURSE, topicId: 7, downloadPath: targetDir });

    // Nothing may exist outside a/b, whether the download succeeded under a
    // sanitized name or was refused outright.
    const written = await walk(root);
    expect(written).not.toContain("pwned.pdf");
    expect(written).not.toContain("a/pwned.pdf");

    if (!result.isError) {
      const reported = parse(result).filePath as string;
      expect(
        path.resolve(reported).startsWith(path.resolve(targetDir) + path.sep)
      ).toBe(true);
    }
  });

  it("does not write above the download directory for a traversing customFilename", async () => {
    const { call } = setup({ disposition: 'attachment; filename="notes.pdf"' });

    await call({
      courseId: COURSE,
      topicId: 7,
      downloadPath: targetDir,
      customFilename: "../../custom.pdf",
    });

    const written = await walk(root);
    expect(written).not.toContain("custom.pdf");
    expect(written).not.toContain("a/custom.pdf");
  });

  it("does not write into a subdirectory named by the remote filename", async () => {
    // path.join would happily aim at a/b/sub/nested.pdf, which does not exist,
    // and the raw ENOENT surfaced as "An unexpected error occurred".
    const { call } = setup({ disposition: 'attachment; filename="sub/nested.pdf"' });

    const result = await call({ courseId: COURSE, topicId: 7, downloadPath: targetDir });

    expect(textOf(result)).not.toContain("An unexpected error occurred");
    if (!result.isError) {
      expect(path.dirname(parse(result).filePath)).toBe(targetDir);
    }
  });

  it("still saves an ordinary file under its own name and reports it", async () => {
    const { call } = setup({ disposition: 'attachment; filename="Lecture 7.pdf"' });

    const payload = parse(
      await call({ courseId: COURSE, topicId: 7, downloadPath: targetDir })
    );

    expect(payload.success).toBe(true);
    expect(payload.filePath).toBe(path.join(targetDir, "Lecture 7.pdf"));
    expect(payload.originalFilename).toBe("Lecture 7.pdf");
    expect(payload.mimeType).toBe("application/pdf");
    expect(await fs.readFile(payload.filePath)).toHaveLength(521);
  });

  it("appends a counter rather than overwriting an existing file", async () => {
    await fs.writeFile(path.join(targetDir, "Lecture 7.pdf"), "already here");
    const { call } = setup({ disposition: 'attachment; filename="Lecture 7.pdf"' });

    const payload = parse(
      await call({ courseId: COURSE, topicId: 7, downloadPath: targetDir })
    );

    expect(path.basename(payload.filePath)).toBe("Lecture 7(1).pdf");
    expect(await fs.readFile(path.join(targetDir, "Lecture 7.pdf"), "utf-8")).toBe(
      "already here"
    );
  });
});

describe("download_file: dropbox submissions", () => {
  const submission = (id: number, files: unknown[]) => ({ Id: id, Files: files });
  const file = (fileId: number, fileName: string, size = 1024) => ({
    FileId: fileId,
    FileName: fileName,
    Size: size,
  });

  it("finds a file in a later submission, not just the first", async () => {
    // A resubmitted assignment answers with one entry per submission. Reading
    // only submissions[0] reported "not found" for a file the API had just
    // returned, and would have downloaded it under the wrong submission id.
    const { call, rawRequested } = setup({
      submissions: [
        submission(900, [file(11, "draft.pdf")]),
        submission(901, [file(22, "final.pdf")]),
      ],
    });

    const result = await call({
      courseId: COURSE,
      folderId: 5,
      fileId: 22,
      downloadPath: targetDir,
    });

    expect(result.isError).toBeUndefined();
    expect(parse(result).originalFilename).toBe("final.pdf");
    expect(rawRequested[0]).toContain("/submissions/901/files/22/download");
  });

  it("lists every submission's files when the id really is absent", async () => {
    const { call } = setup({
      submissions: [
        submission(900, [file(11, "draft.pdf")]),
        submission(901, [file(22, "final.pdf")]),
      ],
    });

    const result = await call({
      courseId: COURSE,
      folderId: 5,
      fileId: 99,
      downloadPath: targetDir,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("draft.pdf");
    expect(textOf(result)).toContain("final.pdf");
  });

  it("does not crash on a submission that carries no Files array", async () => {
    const { call } = setup({
      submissions: [submission(900, undefined as any), submission(901, [file(22, "final.pdf")])],
    });

    const result = await call({
      courseId: COURSE,
      folderId: 5,
      fileId: 22,
      downloadPath: targetDir,
    });

    expect(textOf(result)).not.toContain("An unexpected error occurred");
    expect(parse(result).originalFilename).toBe("final.pdf");
  });
});

describe("download_file: announcement attachments", () => {
  const newsItem = (attachments: unknown[]) => ({ Id: 55, Title: "Field notes", Attachments: attachments });
  const file = (fileId: number, fileName: string, size = 1024) => ({
    FileId: fileId,
    FileName: fileName,
    Size: size,
  });

  it("saves the attachment under the download directory from the news attachment endpoint", async () => {
    const { call, rawRequested } = setup({
      newsItem: newsItem([file(77, "prompts.pdf")]),
      disposition: 'attachment; filename="prompts.pdf"',
    });

    const payload = parse(
      await call({ courseId: COURSE, newsId: 55, fileId: 77, downloadPath: targetDir })
    );

    expect(payload.filePath).toBe(path.join(targetDir, "prompts.pdf"));
    expect(rawRequested).toEqual(["/d2l/api/le/1.0/101/news/55/attachments/77"]);
  });

  it("does not write above the download directory for a traversing Content-Disposition", async () => {
    const { call } = setup({
      newsItem: newsItem([file(77, "prompts.pdf")]),
      disposition: 'attachment; filename="../../pwned.pdf"',
    });

    await call({ courseId: COURSE, newsId: 55, fileId: 77, downloadPath: targetDir });

    const written = await walk(root);
    expect(written.filter((f) => !f.startsWith("a/b/"))).toEqual([]);
  });

  it("refuses an attachment whose listed size is over the limit without downloading it", async () => {
    const { call, rawRequested } = setup({
      newsItem: newsItem([file(77, "huge.pdf", 200 * 1024 * 1024)]),
    });

    const result = await call({ courseId: COURSE, newsId: 55, fileId: 77, downloadPath: targetDir });

    expect(textOf(result)).toContain("File too large");
    expect(rawRequested).toEqual([]);
  });

  it("refuses a download whose Content-Length is over the limit", async () => {
    const { call } = setup({
      newsItem: newsItem([file(77, "prompts.pdf")]),
      contentLength: 200 * 1024 * 1024,
    });

    const result = await call({ courseId: COURSE, newsId: 55, fileId: 77, downloadPath: targetDir });

    expect(textOf(result)).toContain("File too large");
    expect(await walk(root)).toEqual([]);
  });

  it("names the announcement's files when the fileId is not one of them", async () => {
    const { call } = setup({
      newsItem: newsItem([file(77, "prompts.pdf"), file(78, "rubric.docx")]),
    });

    const result = await call({ courseId: COURSE, newsId: 55, fileId: 99, downloadPath: targetDir });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "File ID 99 not found on this announcement. Available files: prompts.pdf (ID: 77), rubric.docx (ID: 78)"
    );
  });

  it("asks for fileId when newsId is given alone", async () => {
    const { call } = setup({ newsItem: newsItem([file(77, "prompts.pdf")]) });

    const result = await call({ courseId: COURSE, newsId: 55, downloadPath: targetDir });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("newsId and fileId");
  });
});

/**
 * Inline mode: Claude Desktop's MCP server runs on the host filesystem, but
 * its own analysis/sandbox tools run elsewhere and cannot see a file the
 * server writes to disk. Omitting downloadPath routes the file through the
 * tool response itself instead.
 */
describe("download_file: inline mode (downloadPath omitted)", () => {
  it("includes a mode: \"disk\" field alongside the existing disk-mode response shape", async () => {
    const { call } = setup({ disposition: 'attachment; filename="Lecture 7.pdf"' });

    const payload = parse(
      await call({ courseId: COURSE, topicId: 7, downloadPath: targetDir })
    );

    // Everything the pre-existing contract promised is still there...
    expect(payload.success).toBe(true);
    expect(payload.filePath).toBe(path.join(targetDir, "Lecture 7.pdf"));
    expect(payload.originalFilename).toBe("Lecture 7.pdf");
    expect(payload.mimeType).toBe("application/pdf");
    // ...plus the new, additive field.
    expect(payload.mode).toBe("disk");
  });

  it("returns extracted text for a PDF when downloadPath is omitted", async () => {
    const { call } = setup({
      disposition: 'attachment; filename="Lecture 7.pdf"',
      body: minimalPdf("Homework 3 is due Friday"),
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(result.isError).toBeUndefined();
    expect(result.content.every((c: any) => c.type === "text")).toBe(true);
    const metadata = parse(result);
    expect(metadata.mode).toBe("inline");
    expect(metadata.mimeType).toBe("application/pdf");
    expect(metadata.representation).toBe("extracted_text");
    expect(textOf(result)).toContain("Homework 3 is due Friday");
  });

  it("returns an ImageContent block for an image when downloadPath is omitted", async () => {
    const { call } = setup({
      disposition: 'attachment; filename="diagram.jpg"',
      body: jpegBuffer(),
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(result.isError).toBeUndefined();
    const metadata = parse(result);
    expect(metadata.mode).toBe("inline");
    expect(metadata.representation).toBe("image");
    const imageBlock = result.content.find((c: any) => c.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock.mimeType).toBe("image/jpeg");
    expect(imageBlock.data).toBe(jpegBuffer().toString("base64"));
    // Never an EmbeddedResource — Claude Desktop routes those into a document
    // pipeline that rejects some real-world PDFs and would break the response.
    expect(result.content.every((c: any) => c.type === "text" || c.type === "image")).toBe(true);
  });

  it("refuses a file over the inline size cap with a clear error, suggesting disk mode", async () => {
    const oversize = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(11 * 1024 * 1024)]);
    const { call } = setup({
      disposition: 'attachment; filename="huge.pdf"',
      body: oversize,
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too large for inline delivery");
    expect(textOf(result)).toContain("downloadPath");
  });

  it("still enforces the allowlist inline", async () => {
    // An executable's magic bytes (MZ header) — not on ALLOWED_MIME_TYPES.
    const exe = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(256)]);
    const { call } = setup({
      disposition: 'attachment; filename="tool.exe"',
      body: exe,
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not on the allowed download list");
  });

  it("works for submission files too, not just content topics", async () => {
    const { call } = setup({
      submissions: [{ Id: 900, Files: [{ FileId: 22, FileName: "final.pdf", Size: 1024 }] }],
      body: minimalPdf("Final answer: 42"),
    });

    const result = await call({ courseId: COURSE, folderId: 5, fileId: 22 });

    expect(result.isError).toBeUndefined();
    expect(parse(result).mode).toBe("inline");
    expect(textOf(result)).toContain("Final answer: 42");
  });

  it("serializes the inline metadata block as compact JSON, not pretty-printed", async () => {
    const { call } = setup({
      disposition: 'attachment; filename="Lecture 7.pdf"',
      body: minimalPdf("Office hours are Tuesdays"),
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    const metadataText = result.content[0].text;
    expect(metadataText).not.toContain("\n");
    expect(metadataText).not.toContain("  ");
    expect(JSON.parse(metadataText).mode).toBe("inline");
  });

  it("appends the update notice in inline mode just like disk mode", async () => {
    vi.mocked(getUpdateNotice).mockReturnValueOnce("Update available: v2.0.0 to v2.1.0.");

    const { call } = setup({
      disposition: 'attachment; filename="Lecture 7.pdf"',
      body: minimalPdf("Office hours are Tuesdays"),
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(textOf(result)).toContain("Update available: v2.0.0 to v2.1.0.");
  });

  it("falls back to binary_description_only for an image over the inline image cap, even though it fits the overall inline cap", async () => {
    // 4 MB clears INLINE_MAX_SIZE's 10 MB ceiling but should trip the
    // tighter image-only cap: base64 would otherwise push a 6-10 MB image
    // past the model API's ~5 MB image limit and fail the whole response.
    const { call } = setup({
      disposition: 'attachment; filename="diagram.png"',
      body: pngBuffer(4 * 1024 * 1024),
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(result.isError).toBeUndefined();
    const metadata = parse(result);
    expect(metadata.representation).toBe("binary_description_only");
    expect(metadata.note).toContain("downloadPath");
    expect(result.content.some((c: any) => c.type === "image")).toBe(false);
  });

  it("still inlines a PNG under the image cap as an ImageContent block", async () => {
    const { call } = setup({
      disposition: 'attachment; filename="small.png"',
      body: pngBuffer(1024),
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(parse(result).representation).toBe("image");
    const imageBlock = result.content.find((c: any) => c.type === "image");
    expect(imageBlock?.mimeType).toBe("image/png");
  });

  it("extracts text from a DOCX when downloadPath is omitted", async () => {
    const { call } = setup({
      disposition: 'attachment; filename="syllabus.docx"',
      body: fakeDocxBuffer("Office hours are Tuesdays at 2pm"),
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(result.isError).toBeUndefined();
    const metadata = parse(result);
    expect(metadata.mode).toBe("inline");
    expect(metadata.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(metadata.representation).toBe("extracted_text");
    expect(textOf(result)).toContain("Office hours are Tuesdays at 2pm");
  });

  it("returns plain text verbatim for a text/plain file", async () => {
    const { call } = setup({
      disposition: 'attachment; filename="notes.txt"',
      body: Buffer.from("Office hours moved to Friday this week.", "utf-8"),
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(result.isError).toBeUndefined();
    const metadata = parse(result);
    expect(metadata.mode).toBe("inline");
    expect(metadata.mimeType).toBe("text/plain");
    expect(metadata.representation).toBe("text");
    expect(metadata.truncated).toBe(false);
    expect(textOf(result)).toContain("Office hours moved to Friday this week.");
  });

  it("truncates extracted text at 400,000 characters and says so", async () => {
    const { call } = setup({
      disposition: 'attachment; filename="notes.txt"',
      body: Buffer.from("a".repeat(400_050), "utf-8"),
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    const metadata = parse(result);
    expect(metadata.truncated).toBe(true);
    expect(textOf(result)).toContain("[...truncated at 400000 characters");
    expect(textOf(result)).toContain("downloadPath");
  });

  it("reports binary_description_only and points to downloadPath for a type with no inline representation", async () => {
    const { call } = setup({
      disposition: 'attachment; filename="archive.zip"',
      body: plainZipBuffer(),
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(result.isError).toBeUndefined();
    const metadata = parse(result);
    expect(metadata.mode).toBe("inline");
    expect(metadata.mimeType).toBe("application/zip");
    expect(metadata.representation).toBe("binary_description_only");
    expect(metadata.note).toContain("downloadPath");
    // Only the one metadata block — no attempt to inline the raw bytes.
    expect(result.content).toHaveLength(1);
  });

  it("reports pdf_text_extraction_failed for a PDF with no readable text layer", async () => {
    const { call } = setup({
      disposition: 'attachment; filename="scan.pdf"',
      body: pdfBuffer(), // a bare %PDF-1.4 header with no real page content
    });

    const result = await call({ courseId: COURSE, topicId: 7 });

    expect(result.isError).toBeUndefined();
    const metadata = parse(result);
    expect(metadata.mode).toBe("inline");
    expect(metadata.representation).toBe("pdf_text_extraction_failed");
    expect(metadata.note).toContain("downloadPath");
  });
});
