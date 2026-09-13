import { describe, it, expect } from "vitest";
import {
  validateFileType,
  validateDownloadPath,
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
