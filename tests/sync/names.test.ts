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
    expect(sanitizeComponent("../../x", "fallback")).toBe("_.._.._x");
    expect(sanitizeComponent("/etc/passwd", "fallback")).not.toContain("/");
    expect(sanitizeComponent("C:\\Windows\\x", "fallback")).not.toMatch(/[\\:]/);
  });

  it.each([
    [".ssh", "_.ssh"],
    [".zshrc", "_.zshrc"],
    ["..hidden", "_..hidden"],
    [".config.d", "_.config.d"],
    [" .bashrc", "_.bashrc"],
  ])("prefixes the dot name %j so it cannot be a dot-file or dot-folder", (raw, expected) => {
    expect(sanitizeComponent(raw, "x")).toBe(expected);
  });

  it("leaves a dot inside a name alone", () => {
    expect(sanitizeComponent("notes.v2.pdf", "x")).toBe("notes.v2.pdf");
  });

  it("honours a smaller cap and keeps the extension", () => {
    const out = sanitizeComponent(`${"a".repeat(80)}.pdf`, "x", 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith(".pdf")).toBe(true);
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

  it("does not let a Url name a dot-file", () => {
    expect(fileNameFromTopic("/content/enforced/1-x/.zshrc", "T", "x")).toBe("_.zshrc");
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

  it("keeps numbered names under a smaller cap", () => {
    const names = new NameSet(20);
    names.add("abcdefghijklmnop.pdf");
    expect(names.add("abcdefghijklmnop.pdf").length).toBeLessThanOrEqual(20);
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

import { foldKey } from "../../src/sync/names.js";

describe("foldKey: what a case-insensitive, normalising filesystem treats as equal", () => {
  it.each([
    ["ß", "SS"],
    ["ς", "σ"],
    ["ſ", "s"],
    ["ﬁ", "FI"],
    ["K", "k"],
    ["İ".toLowerCase(), "İ".toLowerCase()],
    ["Café", "CAFÉ"],
    ["Straße.pdf", "STRASSE.PDF"],
  ])("%j equals %j", (a, b) => expect(foldKey(a)).toBe(foldKey(b)));

  it("keeps different names apart", () => {
    expect(foldKey("a.pdf")).not.toBe(foldKey("b.pdf"));
  });
});

describe("NameSet with full case folding", () => {
  it("numbers a file whose name folds to a module folder's name", () => {
    const names = new NameSet();
    expect(names.add("SS", true)).toBe("SS");
    expect(names.add("ß")).toBe("ß (2)");
  });

  it("numbers ß.pdf, SS.pdf and ss.pdf apart", () => {
    const names = new NameSet();
    expect([names.add("ß.pdf"), names.add("SS.pdf"), names.add("ss.PDF")]).toEqual(["ß.pdf", "SS (2).pdf", "ss (3).PDF"]);
  });

  it("numbers in constant time per name: 20,000 duplicates are quick and distinct", () => {
    const names = new NameSet();
    const started = Date.now();
    const out = new Set<string>();
    for (let i = 0; i < 20_000; i++) out.add(names.add("Notes.pdf"));
    expect(out.size).toBe(20_000);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("does not hand out a number that a literal name already holds", () => {
    const names = new NameSet();
    names.add("a.pdf");
    names.add("a (2).pdf");
    expect(names.add("a.pdf")).toBe("a (3).pdf");
  });
});

describe("sanitizeComponent: hostile characters", () => {
  it("replaces a lone surrogate with U+FFFD", () => {
    expect(sanitizeComponent("a\ud800b.pdf", "x")).toBe("a�b.pdf");
    expect(sanitizeComponent("a\udfffb", "x")).toBe("a�b");
  });

  it.each(["⁠", "­", "؜", "͏", "ㅤ", "ᅟ", "ᅠ", "﻿", "\u{e0001}", "\u{e0041}", "️", "\u{e0100}", "⁦", "⁪", "́", "​"])(
    "cannot hide a leading dot behind U+%s",
    (invisible) => {
      expect(sanitizeComponent(`${invisible}.ssh`, "x")).toBe("_.ssh");
      expect(sanitizeComponent(`${invisible}${invisible}.zshrc`, "x")).toBe("_.zshrc");
    },
  );

  it.each([["a﷐b", "a_b"], ["a﷯b", "a_b"], ["a￿b", "a_b"], ["a￾b", "a_b"], ["a\u{1fffe}b", "a_b"], ["a\u{10ffff}b", "a_b"], ["ab", "a_b"], ["a\u{f0000}b", "a_b"], ["a͸b", "a_b"]])(
    "replaces the noncharacter, private-use or unassigned code point in %j",
    (raw, expected) => expect(sanitizeComponent(raw, "x")).toBe(expected),
  );

  it("keeps ordinary non-Latin text and emoji", () => {
    expect(sanitizeComponent("講義ノート😀.pdf", "x")).toBe("講義ノート😀.pdf");
  });
});

describe("sanitizeComponent: reserved names are judged on the final name", () => {
  it.each(["CONIN$", "CONOUT$", "conin$.txt", "CONOUT$.tar.gz"])("prefixes %s", (name) => {
    expect(sanitizeComponent(name, "x")).toBe(`_${name}`);
  });

  it("catches a name that only becomes reserved once clipped and trimmed", () => {
    const out = sanitizeComponent(`COM1${" ".repeat(200)}x`, "f");
    expect(out).toBe("_COM1");
  });

  it("catches one that is reserved once trailing dots and spaces go", () => {
    expect(sanitizeComponent("NUL. . .", "x")).toBe("_NUL");
  });

  it("still fits the cap after the prefix is added", () => {
    const out = sanitizeComponent(`aux${"x".repeat(0)}`, "x", 4);
    expect(out.length).toBeLessThanOrEqual(4);
  });
});

describe("length cap holds for small caps", () => {
  it.each([16, 17, 20, 24])("sanitizeComponent never exceeds %i characters, whatever the extension", (cap) => {
    for (const raw of [`${"a".repeat(80)}.pdf`, `a.${"e".repeat(19)}`, `${"b".repeat(5)}.${"x".repeat(20)}`, "😀".repeat(60), `.${"z".repeat(40)}`]) {
      expect(Array.from(sanitizeComponent(raw, "fallback", cap)).length, `${raw} @ ${cap}`).toBeLessThanOrEqual(cap);
    }
  });

  it.each([16, 20])("NameSet at %i characters stays under the cap for every number, extension or not", (cap) => {
    const names = new NameSet(cap);
    for (const raw of [`a.${"e".repeat(19)}`, `${"c".repeat(16)}.pdf`, "x".repeat(16)]) {
      const name = sanitizeComponent(raw, "x", cap);
      for (let i = 0; i < 12; i++) expect(Array.from(names.add(name)).length).toBeLessThanOrEqual(cap);
    }
  });
});

describe("fileNameFromTopic: escapes are never left for a second decode", () => {
  it("neutralises an escape that survives in the title fallback too", () => {
    const name = fileNameFromTopic("", "%2e%2e%2fevil%2500", "x");
    expect(decodeURIComponent(name)).toBe(name);
    expect(name).not.toMatch(/[\\/]/);
  });
});
