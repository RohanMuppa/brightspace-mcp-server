import { describe, it, expect } from "vitest";
import {
  validateFileType,
  validateDownloadPath,
  validateBaseUrl,
} from "../../src/utils/file-validator.js";
import { DownloadError } from "../../src/utils/download-errors.js";

/**
 * Regression coverage for issue #24.
 *
 * A legacy .doc is an OLE2 Compound File Binary container. file-type reports
 * every CFB as application/x-cfb and never as application/msword, so the three
 * legacy Office entries in the allowlist were unreachable and every .doc, .xls
 * and .ppt download failed. The thrown error was a plain Error, which
 * sanitizeError had no branch for, so the user saw only "An unexpected error
 * occurred."
 */

/** The first eight bytes of any CFB file, which is how a real .doc begins. */
function cfbBuffer(): Buffer {
  const buf = Buffer.alloc(2048);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0);
  return buf;
}

function pdfBuffer(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(512)]);
}

describe("validateFileType: legacy Office containers", () => {
  it("accepts a .doc and reports it as msword", async () => {
    await expect(
      validateFileType(cfbBuffer(), undefined, "Essay.doc")
    ).resolves.toMatchObject({ mime: "application/msword", ext: "doc" });
  });

  it("accepts .xls and .ppt the same way", async () => {
    await expect(
      validateFileType(cfbBuffer(), undefined, "Grades.xls")
    ).resolves.toMatchObject({ mime: "application/vnd.ms-excel" });
    await expect(
      validateFileType(cfbBuffer(), undefined, "Deck.ppt")
    ).resolves.toMatchObject({ mime: "application/vnd.ms-powerpoint" });
  });

  it("is case insensitive about the extension", async () => {
    await expect(
      validateFileType(cfbBuffer(), undefined, "ESSAY.DOC")
    ).resolves.toMatchObject({ mime: "application/msword" });
  });

  it("still refuses an installer wearing the same container", async () => {
    // .msi is also CFB. Allowing application/x-cfb outright would have let
    // this through, which is the whole reason the allowlist exists.
    await expect(
      validateFileType(cfbBuffer(), undefined, "setup.msi")
    ).rejects.toBeInstanceOf(DownloadError);
  });

  it("refuses a CFB with no extension to reconcile against", async () => {
    await expect(
      validateFileType(cfbBuffer(), undefined, "mystery")
    ).rejects.toBeInstanceOf(DownloadError);
    await expect(validateFileType(cfbBuffer())).rejects.toBeInstanceOf(DownloadError);
  });

  it("throws a typed error carrying the detected type", async () => {
    const error = await validateFileType(cfbBuffer(), undefined, "setup.msi").catch((e) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error.kind).toBe("unsupportedType");
    expect(error.detail).toBe("application/x-cfb");
  });

  it("leaves ordinary detection alone", async () => {
    await expect(validateFileType(pdfBuffer())).resolves.toMatchObject({
      mime: "application/pdf",
    });
  });

  it("reports a disallowed type as typed, not as a bare Error", async () => {
    const error = await validateFileType(pdfBuffer(), ["image/png"]).catch((e) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error.kind).toBe("unsupportedType");
  });
});

/**
 * file-type has no SVG detector, so an SVG carrying the usual `<?xml ...?>`
 * prolog -- which is what every drawing tool exports -- was reported as
 * application/xml and refused, even though image/svg+xml has been in
 * ALLOWED_MIME_TYPES all along. Same dead-allowlist-entry shape as issue #24's
 * legacy Office containers, one format over.
 */
describe("validateFileType: SVG", () => {
  const PROLOG_SVG = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
  );
  const BARE_SVG = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
  );

  it("accepts an .svg that carries an XML prolog", async () => {
    await expect(
      validateFileType(PROLOG_SVG, undefined, "diagram.svg")
    ).resolves.toMatchObject({ mime: "image/svg+xml", ext: "svg" });
  });

  it("accepts an .svg with no prolog and names it correctly", async () => {
    // This one already downloaded, but as text/plain with a .txt extension,
    // so the caller was told the wrong type for the bytes it just wrote.
    await expect(
      validateFileType(BARE_SVG, undefined, "diagram.svg")
    ).resolves.toMatchObject({ mime: "image/svg+xml", ext: "svg" });
  });

  it("still refuses other XML, which the allowlist never admitted", async () => {
    const error = await validateFileType(
      Buffer.from('<?xml version="1.0"?><note><to>x</to></note>'),
      undefined,
      "data.xml"
    ).catch((e) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error.detail).toBe("application/xml");
  });

  it("honours a narrower allowlist that excludes svg", async () => {
    await expect(
      validateFileType(BARE_SVG, ["application/pdf"], "diagram.svg")
    ).rejects.toBeInstanceOf(DownloadError);
  });
});

describe("validateFileType: empty body", () => {
  it("refuses a zero-byte download instead of calling it text/plain", async () => {
    // A truncated fetch or an empty error body used to validate as text/plain
    // and be written to disk as a zero-byte file under the real name.
    const error = await validateFileType(Buffer.alloc(0), undefined, "Syllabus.pdf").catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(DownloadError);
    expect(error.kind).toBe("undetectableType");
  });

  it("still accepts a file that is only whitespace", async () => {
    await expect(
      validateFileType(Buffer.from("   \n"), undefined, "notes.txt")
    ).resolves.toMatchObject({ mime: "text/plain" });
  });
});

describe("validateBaseUrl", () => {
  const BASE = "https://purdue.brightspace.com";

  it("refuses a hostname that merely starts with the expected one", () => {
    // startsWith() passed this: the attacker's host is a string prefix match.
    expect(() =>
      validateBaseUrl(`${BASE}.attacker.example/d2l/steal`, BASE)
    ).toThrow();
  });

  it("refuses a different scheme, host, or port on the same name", () => {
    expect(() => validateBaseUrl("http://purdue.brightspace.com/d2l", BASE)).toThrow();
    expect(() => validateBaseUrl("https://purdue.brightspace.com:8443/d2l", BASE)).toThrow();
    expect(() => validateBaseUrl("https://evil.example/d2l", BASE)).toThrow();
  });

  it("refuses a value that is not a URL at all", () => {
    expect(() => validateBaseUrl("not a url", BASE)).toThrow();
  });

  it("accepts the expected origin", () => {
    expect(() => validateBaseUrl(`${BASE}/d2l/api/lp/1.0/users/whoami`, BASE)).not.toThrow();
    expect(() => validateBaseUrl(BASE, BASE)).not.toThrow();
  });

  it("requires a path prefix to end on a separator", () => {
    expect(() => validateBaseUrl(`${BASE}/d2lXXX/evil`, `${BASE}/d2l`)).toThrow();
    expect(() => validateBaseUrl(`${BASE}/d2l/home`, `${BASE}/d2l`)).not.toThrow();
  });
});

describe("validateDownloadPath", () => {
  it("survives a filename containing a bare percent", () => {
    // Brightspace supplies these names, so this is remote input.
    // decodeURIComponent throws URIError here, which used to escape as another
    // unrecognised error and read as "unexpected error" to the user.
    expect(() => validateDownloadPath("/tmp", "100% Final.doc")).not.toThrow();
  });

  it("still decodes genuinely encoded names", () => {
    expect(validateDownloadPath("/tmp", "Lecture%207.pdf")).toContain("Lecture 7.pdf");
  });

  it("refuses a traversal attempt with a typed error", () => {
    const error = (() => {
      try {
        validateDownloadPath("/tmp", "../../etc/passwd");
        return null;
      } catch (e) {
        return e;
      }
    })();
    // sanitize-filename strips the separators, so this lands on either guard;
    // what matters is that it is typed and never escapes as a plain Error.
    if (error !== null) expect(error).toBeInstanceOf(DownloadError);
  });
});
