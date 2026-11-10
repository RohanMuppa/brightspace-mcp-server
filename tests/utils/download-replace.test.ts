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
  new ReadableStream({ start(c) { c.enqueue(new Uint8Array(data)); c.close(); } });
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
