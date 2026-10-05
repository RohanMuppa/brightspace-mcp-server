import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { secureDownload, secureStreamDownload, resolveFilenameConflict, readBodyCapped } from "../../src/utils/download-helpers.js";
import { DownloadError } from "../../src/utils/download-errors.js";
import { MAX_FILE_SIZE } from "../../src/utils/file-validator.js";

/**
 * secureDownload is the only thing standing between a filename Brightspace
 * chose and a write to disk. It called validateDownloadPath and then wrote to
 * path.join(targetDir, rawFilename) anyway, so the validated path was never the
 * path used and a "../../" name escaped the download directory entirely.
 */

function pdfBuffer(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(512)]);
}

let root: string;
let targetDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "secure-download-"));
  targetDir = path.join(root, "a", "b");
  await fs.mkdir(targetDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const inside = (p: string) =>
  path.resolve(p).startsWith(path.resolve(targetDir) + path.sep);

describe("secureDownload: path containment", () => {
  it("never writes above the target directory", async () => {
    const result = await secureDownload({
      targetDir,
      filename: "../../pwned.pdf",
      data: pdfBuffer(),
    }).catch((e) => e);

    if (result instanceof Error) {
      expect(result).toBeInstanceOf(DownloadError);
    } else {
      expect(inside(result.path)).toBe(true);
    }
    await expect(fs.access(path.join(root, "pwned.pdf"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "a", "pwned.pdf"))).rejects.toThrow();
  });

  it("never writes above the target directory for a percent-encoded traversal", async () => {
    const result = await secureDownload({
      targetDir,
      filename: "..%2F..%2Fencoded.pdf",
      data: pdfBuffer(),
    }).catch((e) => e);

    if (result instanceof Error) {
      expect(result).toBeInstanceOf(DownloadError);
    } else {
      expect(inside(result.path)).toBe(true);
    }
    await expect(fs.access(path.join(root, "encoded.pdf"))).rejects.toThrow();
  });

  it("never writes into a subdirectory the filename asked for", async () => {
    const result = await secureDownload({
      targetDir,
      filename: "sub/nested.pdf",
      data: pdfBuffer(),
    });

    expect(path.dirname(result.path)).toBe(targetDir);
  });

  it("refuses an absolute filename rather than aiming outside", async () => {
    const result = await secureDownload({
      targetDir,
      filename: path.join(root, "absolute.pdf"),
      data: pdfBuffer(),
    }).catch((e) => e);

    if (result instanceof Error) {
      expect(result).toBeInstanceOf(DownloadError);
    } else {
      expect(inside(result.path)).toBe(true);
    }
    await expect(fs.access(path.join(root, "absolute.pdf"))).rejects.toThrow();
  });
});

describe("secureDownload: ordinary downloads still work", () => {
  it("writes the file and reports its path, size and type", async () => {
    const data = pdfBuffer();
    const result = await secureDownload({ targetDir, filename: "Lecture 7.pdf", data });

    expect(result.path).toBe(path.join(targetDir, "Lecture 7.pdf"));
    expect(result.size).toBe(data.byteLength);
    expect(result.mime).toBe("application/pdf");
    expect(await fs.readFile(result.path)).toEqual(data);
  });

  it("decodes a percent-encoded name instead of saving the escape literally", async () => {
    const result = await secureDownload({
      targetDir,
      filename: "Lecture%207.pdf",
      data: pdfBuffer(),
    });

    expect(path.basename(result.path)).toBe("Lecture 7.pdf");
  });

  it("keeps a bare percent in a name usable", async () => {
    const result = await secureDownload({
      targetDir,
      filename: "100% Final.pdf",
      data: pdfBuffer(),
    });

    expect(path.basename(result.path)).toBe("100% Final.pdf");
  });

  it("resolves a conflict rather than overwriting", async () => {
    await fs.writeFile(path.join(targetDir, "notes.pdf"), "already here");

    const result = await secureDownload({
      targetDir,
      filename: "notes.pdf",
      data: pdfBuffer(),
    });

    expect(path.basename(result.path)).toBe("notes(1).pdf");
    expect(await fs.readFile(path.join(targetDir, "notes.pdf"), "utf-8")).toBe(
      "already here"
    );
  });

  it("still refuses a type that is not on the allowlist", async () => {
    // A legacy .doc container under an installer's extension.
    const cfb = Buffer.alloc(2048);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cfb, 0);

    await expect(
      secureDownload({ targetDir, filename: "setup.msi", data: cfb })
    ).rejects.toBeInstanceOf(DownloadError);
    expect(await fs.readdir(targetDir)).toEqual([]);
  });

  it("still resolves a legacy Office container by its extension", async () => {
    const cfb = Buffer.alloc(2048);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(cfb, 0);

    const result = await secureDownload({ targetDir, filename: "Essay.doc", data: cfb });
    expect(result.mime).toBe("application/msword");
  });
});

describe("resolveFilenameConflict", () => {
  it("returns the original name when nothing is in the way", async () => {
    expect(await resolveFilenameConflict(targetDir, "fresh.pdf")).toBe("fresh.pdf");
  });

  it("counts up past several existing files", async () => {
    for (const name of ["x.pdf", "x(1).pdf", "x(2).pdf"]) {
      await fs.writeFile(path.join(targetDir, name), "x");
    }
    expect(await resolveFilenameConflict(targetDir, "x.pdf")).toBe("x(3).pdf");
  });
});

/** A web stream delivering the given chunks, the way fetch hands over a body. */
function streamOf(...chunks: Buffer[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("secureStreamDownload", () => {
  it("writes the streamed file and reports its path, size and type", async () => {
    const result = await secureStreamDownload({
      targetDir,
      filename: "deck.pdf",
      body: streamOf(Buffer.from("%PDF-1.4\n"), Buffer.alloc(1000)),
      maxBytes: 1024 * 1024,
    });

    expect(result).toEqual({ path: path.join(targetDir, "deck.pdf"), size: 1009, mime: "application/pdf" });
  });

  it("refuses a body that grows past maxBytes", async () => {
    const attempt = secureStreamDownload({
      targetDir,
      filename: "deck.pdf",
      body: streamOf(Buffer.from("%PDF-1.4\n"), Buffer.alloc(2000)),
      maxBytes: 1024,
    });

    await expect(attempt).rejects.toMatchObject({ kind: "tooLarge" });
  });

  it("leaves nothing in the directory after refusing an oversize body", async () => {
    await secureStreamDownload({
      targetDir,
      filename: "deck.pdf",
      body: streamOf(Buffer.from("%PDF-1.4\n"), Buffer.alloc(2000)),
      maxBytes: 1024,
    }).catch(() => undefined);

    expect(await fs.readdir(targetDir)).toEqual([]);
  });

  it("never writes above the target directory", async () => {
    const result = await secureStreamDownload({
      targetDir,
      filename: "../../escape.pdf",
      body: streamOf(pdfBuffer()),
      maxBytes: 1024 * 1024,
    });

    expect(inside(result.path)).toBe(true);
  });

  it("resolves a conflict rather than overwriting", async () => {
    await fs.writeFile(path.join(targetDir, "deck.pdf"), "already here");

    const result = await secureStreamDownload({
      targetDir,
      filename: "deck.pdf",
      body: streamOf(pdfBuffer()),
      maxBytes: 1024 * 1024,
    });

    expect(path.basename(result.path)).toBe("deck(1).pdf");
  });

  it("keeps both files when two same-name downloads race", async () => {
    // Hold both existence checks for deck.pdf until each download has made
    // one, so both see the name as free before either publishes.
    const realAccess = fs.access.bind(fs);
    const target = path.join(targetDir, "deck.pdf");
    let waiting = 0;
    let release!: () => void;
    const bothChecked = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(fs, "access").mockImplementation(async (p, mode) => {
      if (p === target && waiting < 2) {
        if (++waiting === 2) release();
        await bothChecked;
      }
      return realAccess(p, mode);
    });

    const first = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(512, 1)]);
    const second = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(512, 2)]);
    const results = await Promise.all([
      secureStreamDownload({ targetDir, filename: "deck.pdf", body: streamOf(first), maxBytes: 1024 * 1024 }),
      secureStreamDownload({ targetDir, filename: "deck.pdf", body: streamOf(second), maxBytes: 1024 * 1024 }),
    ]);

    expect(waiting).toBe(2);
    expect(results[0].path).not.toBe(results[1].path);
    expect(await fs.readFile(results[0].path)).toEqual(first);
    expect(await fs.readFile(results[1].path)).toEqual(second);
    expect((await fs.readdir(targetDir)).sort()).toEqual(["deck(1).pdf", "deck.pdf"]);
  });

  it("still accepts a plain text file, which has no magic bytes", async () => {
    const result = await secureStreamDownload({
      targetDir,
      filename: "notes.txt",
      body: streamOf(Buffer.from("week 3 notes\n")),
      maxBytes: 1024 * 1024,
    });

    expect(result.mime).toBe("text/plain");
  });

  it("still refuses a type that is not on the allowlist", async () => {
    const attempt = secureStreamDownload({
      targetDir,
      filename: "setup.exe",
      body: streamOf(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4096, 0xff)])),
      maxBytes: 1024 * 1024,
    });

    await expect(attempt).rejects.toBeInstanceOf(DownloadError);
  });
});

/**
 * Regression coverage for issue #184. Plain text has no magic bytes, and the
 * on-disk validator refused any such file over MAX_FILE_SIZE (50 MB) even
 * though the disk download limit is 2 GB, so a large .txt, .csv or .json was
 * streamed to disk and then deleted as undetectable.
 */
describe("secureStreamDownload: large plain text", () => {
  it("accepts valid UTF-8 text larger than MAX_FILE_SIZE", async () => {
    const line = Buffer.from("café, naïve, 日本語 — plain notes\n");
    const chunk = Buffer.concat(Array(Math.ceil((1024 * 1024) / line.length)).fill(line));
    const chunks: Buffer[] = Array(51).fill(chunk);

    const result = await secureStreamDownload({
      targetDir,
      filename: "notes.txt",
      body: streamOf(...chunks),
      maxBytes: 2 * 1024 * 1024 * 1024,
    });

    expect(result.mime).toBe("text/plain");
    expect(result.size).toBe(chunk.length * 51);
    expect(result.size).toBeGreaterThan(MAX_FILE_SIZE);
    expect((await fs.stat(result.path)).size).toBe(result.size);
  }, 30_000);
});

describe("readBodyCapped", () => {
  it("returns a body at or under the cap", async () => {
    const buffer = await readBodyCapped(new Response(new Uint8Array([1, 2, 3])), 3);
    expect([...buffer]).toEqual([1, 2, 3]);
  });

  it("cancels the stream and throws tooLarge once the body passes the cap", async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });

    const error = await readBodyCapped(new Response(body), 10).catch((e) => e);

    expect(error).toBeInstanceOf(DownloadError);
    expect(error.kind).toBe("tooLarge");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(4);
  });
});
