import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractPdfText } from "../../src/utils/pdf-extractor.js";

/**
 * PDF bytes come from a course attachment, so they are remote input and can be
 * malformed, truncated, or hostile. The contract is graceful degradation: the
 * extractor returns null and the download still succeeds without text. Nothing
 * it is handed may throw out of it and take the tool call down.
 */

describe("extractPdfText", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The failure path logs at ERROR; keep the suite's output readable.
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("returns null for an empty buffer", async () => {
    await expect(extractPdfText(Buffer.alloc(0))).resolves.toBeNull();
  });

  it("returns null for bytes that are not a PDF at all", async () => {
    await expect(extractPdfText(Buffer.from("this is plainly not a pdf"))).resolves.toBeNull();
  });

  it("returns null for a PDF header with a broken body", async () => {
    await expect(
      extractPdfText(Buffer.from("%PDF-1.4\nnot actually a pdf body"))
    ).resolves.toBeNull();
  });

  it("returns null for a truncated PDF", async () => {
    await expect(
      extractPdfText(
        Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n")
      )
    ).resolves.toBeNull();
  });

  it("yields no text for a PDF claiming a page count it does not have", async () => {
    // pdf.js repairs this one rather than throwing, so the result is an empty
    // extraction rather than null. Either way the caller gets nothing usable
    // and nothing escapes: `extracted?.text?.trim() || null` at both call
    // sites turns both shapes into the same "no text layer" note.
    const result = await extractPdfText(
      Buffer.from(
        "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
          "2 0 obj\n<< /Type /Pages /Count 999999 /Kids [] >>\nendobj\n" +
          "trailer\n<< /Root 1 0 R >>\n%%EOF\n"
      )
    );
    expect(result?.text ?? "").toBe("");
  });

  it("extracts text from a well-formed PDF", async () => {
    const result = await extractPdfText(minimalPdf("Homework 3 is due Friday"));
    expect(result).not.toBeNull();
    expect(result?.totalPages).toBe(1);
    expect(result?.text).toContain("Homework 3 is due Friday");
  });
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
