import { describe, it, expect, vi } from "vitest";
import { registerGetAnnouncementFiles } from "../../src/tools/get-announcement-files.js";

/**
 * Instructors attach handouts to announcements, not only to content or
 * assignments: field-notes prompts, rubrics, updated schedules. Those files
 * live on the news item, so neither get_course_content nor
 * get_assignment_files could ever reach them.
 */

const COURSE = 101;

const attachment = (fileId: number, fileName: string, size = 1024) => ({
  FileId: fileId,
  FileName: fileName,
  Size: size,
});

const news = (id: number, title: string, attachments: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  Id: id,
  Title: title,
  StartDate: "2026-09-18T00:00:00.000Z",
  CreatedDate: "2026-09-18T00:00:00.000Z",
  IsPublished: true,
  Attachments: attachments,
  ...extra,
});

/** The smallest one-page PDF that really renders the given text. */
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

function setup({ newsItems, file = Buffer.alloc(0) }: { newsItems: unknown; file?: Buffer }) {
  const rawRequested: string[] = [];

  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async () => newsItems),
    getRaw: vi.fn(async (p: string) => {
      rawRequested.push(p);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () =>
          file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
      };
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetAnnouncementFiles(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), rawRequested };
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe("get_announcement_files discovery", () => {
  it("lists only announcements that carry files, and downloads nothing", async () => {
    const { call, rawRequested } = setup({
      newsItems: [
        news(1, "Field notes", [attachment(77, "prompts.pdf", 2048)]),
        news(2, "Reminder", []),
      ],
    });

    const payload = parse(await call({ courseId: COURSE }));

    expect(payload.announcements).toEqual([
      {
        newsId: 1,
        title: "Field notes",
        date: "2026-09-18T00:00:00.000Z",
        attachments: [{ fileId: 77, fileName: "prompts.pdf", size: 2048, kind: "pdf" }],
      },
    ]);
    expect(rawRequested).toEqual([]);
  });

  it("leaves out an unpublished draft's files", async () => {
    const { call } = setup({
      newsItems: [news(1, "Draft", [attachment(77, "prompts.pdf")], { IsPublished: false })],
    });

    const payload = parse(await call({ courseId: COURSE }));
    expect(payload.announcements).toEqual([]);
  });

  it("says so plainly when no announcement has a file", async () => {
    const { call } = setup({ newsItems: [news(1, "Reminder", [])] });

    const payload = parse(await call({ courseId: COURSE }));
    expect(payload.note).toMatch(/no announcement/i);
  });

  it("reports a missing announcement clearly", async () => {
    const { call } = setup({ newsItems: [news(1, "Field notes", [])] });

    const payload = parse(await call({ courseId: COURSE, newsId: 42 }));
    expect(payload.error).toMatch(/no announcement with id 42/i);
  });
});

describe("get_announcement_files reading one file", () => {
  it("returns the text of a PDF attached to an announcement", async () => {
    const { call, rawRequested } = setup({
      newsItems: [news(1, "Field notes", [attachment(77, "prompts.pdf")])],
      file: minimalPdf("Describe the site in three sentences"),
    });

    const payload = parse(await call({ courseId: COURSE, newsId: 1, fileId: 77 }));

    expect(payload.file.text).toContain("Describe the site in three sentences");
    expect(payload.file.truncated).toBe(false);
    expect(rawRequested).toEqual(["/d2l/api/le/1.0/101/news/1/attachments/77"]);
  });

  it("truncates the extracted text at maxChars and says it did", async () => {
    const { call } = setup({
      newsItems: [news(1, "Field notes", [attachment(77, "prompts.pdf")])],
      file: minimalPdf("Describe the site in three sentences"),
    });

    const payload = parse(await call({ courseId: COURSE, newsId: 1, fileId: 77, maxChars: 8 }));

    expect(payload.file.text).toBe("Describe");
    expect(payload.file.truncated).toBe(true);
  });

  it("returns metadata only for a file type it cannot read", async () => {
    const { call } = setup({
      newsItems: [news(1, "Field notes", [attachment(77, "map.png")])],
      file: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });

    const payload = parse(await call({ courseId: COURSE, newsId: 1, fileId: 77 }));

    expect(payload.file).toMatchObject({ fileId: 77, fileName: "map.png", kind: "image", text: null });
    expect(payload.file.note).toMatch(/download_file/);
  });

  it("names the available files when the fileId is wrong", async () => {
    const { call } = setup({
      newsItems: [news(1, "Field notes", [attachment(77, "prompts.pdf")])],
    });

    const payload = parse(await call({ courseId: COURSE, newsId: 1, fileId: 99 }));

    expect(payload.error).toMatch(/no attachment with id 99/i);
    expect(payload.available.map((a: any) => a.fileId)).toEqual([77]);
  });

  it("requires newsId when fileId is given", async () => {
    const { call } = setup({ newsItems: [news(1, "Field notes", [attachment(77, "a.pdf")])] });

    const payload = parse(await call({ courseId: COURSE, fileId: 77 }));
    expect(payload.error).toMatch(/newsId is required/i);
  });
});
