import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { extractZipEntry, officeDocumentText } from "../../src/utils/zip-extract.js";

/**
 * DOCX, XLSX, and PPTX are ZIP archives, and the attachments actually found on
 * a live Purdue course were a DOCX and an XLSX, not PDFs. This reader walks the
 * central directory rather than scanning for local header magic, because file
 * content can contain those same four bytes.
 */

interface Entry {
  name: string;
  content: Buffer;
  deflate?: boolean;
}

/** Build a real ZIP so the tests exercise parsing, not a fixture's shape. */
function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf-8");
    const stored = entry.deflate ? deflateRawSync(entry.content) : entry.content;
    const method = entry.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // crc, unchecked by the reader
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localBlock = Buffer.concat([local, name, stored]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(stored.length, 20);
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

describe("extractZipEntry", () => {
  it("reads a stored entry", () => {
    const zip = buildZip([{ name: "a.txt", content: Buffer.from("hello") }]);
    expect(extractZipEntry(zip, "a.txt")?.toString()).toBe("hello");
  });

  it("reads a deflated entry", () => {
    const body = "x".repeat(500);
    const zip = buildZip([{ name: "b.txt", content: Buffer.from(body), deflate: true }]);
    expect(extractZipEntry(zip, "b.txt")?.toString()).toBe(body);
  });

  it("finds the right entry among several", () => {
    const zip = buildZip([
      { name: "first.txt", content: Buffer.from("one") },
      { name: "word/document.xml", content: Buffer.from("two"), deflate: true },
      { name: "last.txt", content: Buffer.from("three") },
    ]);
    expect(extractZipEntry(zip, "word/document.xml")?.toString()).toBe("two");
  });

  it("is not fooled by local header magic inside file content", () => {
    // A scanner looking for 0x04034b50 would find this and read garbage.
    const trap = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("not really an entry"),
    ]);
    const zip = buildZip([
      { name: "trap.bin", content: trap },
      { name: "real.txt", content: Buffer.from("payload") },
    ]);
    expect(extractZipEntry(zip, "real.txt")?.toString()).toBe("payload");
  });

  it("returns null rather than throwing on bad input", () => {
    const zip = buildZip([{ name: "a.txt", content: Buffer.from("hello") }]);
    expect(extractZipEntry(zip, "missing.txt")).toBeNull();
    expect(extractZipEntry(zip.subarray(0, 12), "a.txt")).toBeNull();
    expect(extractZipEntry(Buffer.from("not a zip at all"), "a.txt")).toBeNull();
    expect(extractZipEntry(Buffer.alloc(0), "a.txt")).toBeNull();
  });
});

describe("officeDocumentText", () => {
  it("pulls readable text out of a DOCX", () => {
    const xml =
      "<w:document><w:body><w:p><w:r><w:t>Lab 4 spec</w:t></w:r>" +
      "<w:r><w:t>Submit a PDF</w:t></w:r></w:p></w:body></w:document>";
    const zip = buildZip([
      { name: "[Content_Types].xml", content: Buffer.from("<Types/>") },
      { name: "word/document.xml", content: Buffer.from(xml), deflate: true },
    ]);
    const text = officeDocumentText(zip);
    expect(text).toContain("Lab 4 spec");
    expect(text).toContain("Submit a PDF");
    expect(text).not.toContain("<w:t>");
  });

  it("pulls shared strings out of an XLSX", () => {
    const xml = "<sst><si><t>Week 1</t></si><si><t>Points</t></si></sst>";
    const zip = buildZip([
      { name: "xl/workbook.xml", content: Buffer.from("<workbook/>") },
      { name: "xl/sharedStrings.xml", content: Buffer.from(xml), deflate: true },
    ]);
    const text = officeDocumentText(zip);
    expect(text).toContain("Week 1");
    expect(text).toContain("Points");
  });

  it("concatenates PPTX slides in order", () => {
    const slide = (n: number) => `<p:sld><a:t>Slide ${n}</a:t></p:sld>`;
    const zip = buildZip([
      { name: "ppt/slides/slide1.xml", content: Buffer.from(slide(1)) },
      { name: "ppt/slides/slide2.xml", content: Buffer.from(slide(2)) },
    ]);
    const text = officeDocumentText(zip) ?? "";
    expect(text.indexOf("Slide 1")).toBeLessThan(text.indexOf("Slide 2"));
  });

  it("decodes XML entities and collapses whitespace", () => {
    const xml = "<w:t>A &amp; B</w:t>\n\n   <w:t>C&lt;D</w:t>";
    const zip = buildZip([{ name: "word/document.xml", content: Buffer.from(xml) }]);
    const text = officeDocumentText(zip);
    expect(text).toContain("A & B");
    expect(text).toContain("C<D");
    expect(text).not.toMatch(/ {3}/);
  });

  it("returns null for a zip that is not an Office document", () => {
    const zip = buildZip([{ name: "notes.txt", content: Buffer.from("plain") }]);
    expect(officeDocumentText(zip)).toBeNull();
  });

  it("returns null when the document has no readable text", () => {
    const zip = buildZip([{ name: "word/document.xml", content: Buffer.from("<w:body/>") }]);
    expect(officeDocumentText(zip)).toBeNull();
  });
});
