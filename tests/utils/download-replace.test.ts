import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { secureStreamDownload } from "../../src/utils/download-helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "download-replace-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const stream = (data: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream({ start(c) { if (data.length) c.enqueue(new Uint8Array(data)); c.close(); } });
const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n${tag}\n`);
const cfb = () => Buffer.concat([Buffer.from("D0CF11E0A1B11AE1", "hex"), Buffer.alloc(600)]);

describe("secureStreamDownload: replaceExisting", () => {
  it("overwrites the exact target it was asked to write", async () => {
    await fs.writeFile(path.join(dir, "a.pdf"), "old");
    const result = await secureStreamDownload({ targetDir: dir, filename: "a.pdf", body: stream(pdf("new")), maxBytes: 1e6, replaceExisting: true });
    expect(path.basename(result.path)).toBe("a.pdf");
    expect(await fs.readFile(path.join(dir, "a.pdf"))).toEqual(pdf("new"));
    expect(await fs.readdir(dir)).toEqual(["a.pdf"]);
  });

  it("never overwrites an unplanned sibling when the extension is corrected", async () => {
    // A legacy Office file asked for as a.pdf is saved as a.xls; an a.xls that is
    // already there belongs to someone else.
    await fs.writeFile(path.join(dir, "a.xls"), "USER DATA");
    await fs.writeFile(path.join(dir, "a.pdf"), "planned target");
    const result = await secureStreamDownload({
      targetDir: dir, filename: "a.pdf", originalFilename: "z.xls", body: stream(cfb()), maxBytes: 1e6, replaceExisting: true,
    });
    expect(await fs.readFile(path.join(dir, "a.xls"), "utf8")).toBe("USER DATA");
    expect(await fs.readFile(path.join(dir, "a.pdf"), "utf8")).toBe("planned target");
    expect(path.basename(result.path)).not.toBe("a.xls");
    expect(path.extname(result.path)).toBe(".xls");
  });
});

describe("secureStreamDownload: abort", () => {
  it("stops when the signal aborts and leaves nothing behind", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(pdf("x"))); },
      pull() { controller.abort(); return new Promise(() => {}); },
    });
    const error = await secureStreamDownload({ targetDir: dir, filename: "a.pdf", body, maxBytes: 1e6, signal: controller.signal }).catch((e) => e);
    expect((error as Error).name).toBe("AbortError");
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

describe("secureStreamDownload: verbatimName and empty bodies", () => {
  it("saves a planned name exactly, without decoding it a second time", async () => {
    const result = await secureStreamDownload({ targetDir: dir, filename: "a%41.pdf", body: stream(pdf("x")), maxBytes: 1e6, verbatimName: true });
    expect(path.basename(result.path)).toBe("a%41.pdf");
    expect(await fs.readdir(dir)).toEqual(["a%41.pdf"]);
  });

  it("without it, the downloader still decodes (its behaviour for other tools is unchanged)", async () => {
    const result = await secureStreamDownload({ targetDir: dir, filename: "a%41.pdf", body: stream(pdf("x")), maxBytes: 1e6 });
    expect(path.basename(result.path)).toBe("aA.pdf");
  });

  it.each(["", ".", "..", "a/b", "a\\b", "a\u0000b", "../x", "x".repeat(300)])("refuses %j as a verbatim name", async (name) => {
    const error = await secureStreamDownload({ targetDir: dir, filename: name, body: stream(pdf("x")), maxBytes: 1e6, verbatimName: true }).catch((e) => e);
    expect((error as { kind?: string }).kind).toBe("badFilename");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("reports an empty body as empty, not as an unidentifiable format", async () => {
    const error = await secureStreamDownload({ targetDir: dir, filename: "a.pdf", body: stream(Buffer.alloc(0)), maxBytes: 1e6 }).catch((e) => e);
    expect((error as { kind?: string }).kind).toBe("empty");
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
