import { describe, expect, it } from "vitest";
import { NameSet, fileNameFromTopic, sanitizeComponent } from "../../src/sync/names.js";

describe("sanitizeComponent", () => {
  it.each([
    ['a<b>c:d"e/f\\g|h?i*j', "a_b_c_d_e_f_g_h_i_j"],
    ["Week 1. ", "Week 1"],
    ["name...", "name"],
    ["  padded  ", "padded"],
    ["tab\tand\u0000nul", "tab_and_nul"],
  ])("replaces Windows-invalid characters in %j", (raw, expected) => {
    expect(sanitizeComponent(raw, "x")).toBe(expected);
  });

  it.each(["CON", "con", "PRN", "AUX", "NUL", "COM1", "com9", "LPT1", "LPT9"])("prefixes the reserved name %s", (name) => {
    expect(sanitizeComponent(name, "x")).toBe(`_${name}`);
  });

  it("prefixes a reserved name that carries an extension", () => {
    expect(sanitizeComponent("NUL.txt", "x")).toBe("_NUL.txt");
    expect(sanitizeComponent("com1.tar.gz", "x")).toBe("_com1.tar.gz");
  });

  it("leaves names that merely start like a reserved one", () => {
    expect(sanitizeComponent("CONSOLE.txt", "x")).toBe("CONSOLE.txt");
    expect(sanitizeComponent("COM10.txt", "x")).toBe("COM10.txt");
  });

  it("never returns a dot name, an empty name or a separator", () => {
    expect(sanitizeComponent("..", "fallback")).toBe("fallback");
    expect(sanitizeComponent(".", "fallback")).toBe("fallback");
    expect(sanitizeComponent("", "fallback")).toBe("fallback");
    expect(sanitizeComponent("   ", "fallback")).toBe("fallback");
    expect(sanitizeComponent("../../x", "fallback")).toBe(".._.._x");
    expect(sanitizeComponent("/etc/passwd", "fallback")).not.toContain("/");
    expect(sanitizeComponent("C:\\Windows\\x", "fallback")).not.toMatch(/[\\:]/);
  });

  it("caps a long name at 150 characters and keeps the extension", () => {
    const out = sanitizeComponent(`${"a".repeat(400)}.pdf`, "x");
    expect(out.length).toBeLessThanOrEqual(150);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("caps multi-byte names so the UTF-8 length stays under the filesystem limit", () => {
    const out = sanitizeComponent(`${"講".repeat(300)}.pdf`, "x");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(240);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("does not split a surrogate pair when truncating", () => {
    const out = sanitizeComponent("😀".repeat(200), "x");
    expect(out).toBe(Array.from(out).join(""));
    expect(out).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("normalises to NFC", () => {
    expect(sanitizeComponent("Cafe\u0301.pdf", "x")).toBe("Caf\u00e9.pdf");
  });

  it("drops bidi and zero-width characters", () => {
    expect(sanitizeComponent("a\u202Eb\u200Bc", "x")).toBe("abc");
  });
});

describe("fileNameFromTopic", () => {
  it("uses the basename of the topic Url, ignoring the query", () => {
    expect(fileNameFromTopic("/content/enforced/1-x/Lecture 1.pdf?ou=1", "Title", "x")).toBe("Lecture 1.pdf");
  });

  it("decodes a percent-encoded name", () => {
    expect(fileNameFromTopic("/content/enforced/1-x/Lecture%201%20%28draft%29.pdf", "T", "x")).toBe("Lecture 1 (draft).pdf");
  });

  it("leaves a literal percent sign alone when the name is not percent-encoded", () => {
    expect(fileNameFromTopic("/content/enforced/1-x/100% Final.pdf", "T", "x")).toBe("100% Final.pdf");
  });

  it("does not leave a second layer of percent-encoding for the downloader to decode", () => {
    const name = fileNameFromTopic("/content/enforced/1-x/a%2541.pdf", "T", "x");
    expect(decodeURIComponent(name)).toBe(name);
  });

  it("falls back to the title plus the Url's extension", () => {
    expect(fileNameFromTopic("/content/enforced/1-x/", "Syllabus", "x")).toBe("Syllabus");
    expect(fileNameFromTopic("", "Syllabus", "x")).toBe("Syllabus");
    expect(fileNameFromTopic("/d2l/x/viewContent/9/View.pdf", "", "File 9")).toBe("View.pdf");
  });

  it("keeps a traversal-looking Url name inside one path component", () => {
    const name = fileNameFromTopic("/content/enforced/1-x/..%2F..%2Fevil.pdf", "T", "x");
    expect(name).not.toMatch(/[\\/]/);
  });
});

describe("NameSet", () => {
  it("numbers case-insensitive duplicates from (2)", () => {
    const names = new NameSet();
    expect(names.add("Notes.pdf")).toBe("Notes.pdf");
    expect(names.add("notes.PDF")).toBe("notes (2).PDF");
    expect(names.add("Notes.pdf")).toBe("Notes (3).pdf");
  });

  it("treats folder names as having no extension", () => {
    const names = new NameSet();
    expect(names.add("v1.2", true)).toBe("v1.2");
    expect(names.add("V1.2", true)).toBe("V1.2 (2)");
  });

  it("keeps a numbered name under the length cap", () => {
    const names = new NameSet();
    const long = `${"a".repeat(300)}.pdf`;
    const first = names.add(sanitizeComponent(long, "x"));
    const second = names.add(sanitizeComponent(long, "x"));
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(150);
    expect(second.endsWith(" (2).pdf")).toBe(true);
  });
});
