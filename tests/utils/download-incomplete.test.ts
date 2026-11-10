import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { secureStreamDownload } from "../../src/utils/download-helpers.js";
import { DownloadError } from "../../src/utils/download-errors.js";

/**
 * A server that promises more bytes than it sends and then drops the
 * connection must not leave a truncated file behind that a later sync would
 * take for a complete one.
 */

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048)]);

let dir: string;
let server: http.Server;
let base: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "download-incomplete-"));
  server = http.createServer((req, res) => {
    if (req.url === "/short") {
      // Claims the whole file, sends half of it, then closes the socket.
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(PDF.length) });
      res.write(PDF.subarray(0, PDF.length / 2), () => res.socket?.destroy());
    } else if (req.url === "/whole") {
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": String(PDF.length) });
      res.end(PDF);
    } else {
      // No Content-Length (chunked): nothing to compare against.
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(PDF);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

/** Fetch like the API client does and hand the response to secureStreamDownload. */
async function save(route: string, expectedBytes?: number) {
  const response = await fetch(`${base}${route}`);
  const header = response.headers.get("Content-Length");
  return secureStreamDownload({
    targetDir: dir,
    filename: "Notes.pdf",
    body: response.body!,
    maxBytes: 10_000_000,
    expectedBytes: expectedBytes ?? (header === null ? undefined : Number(header)),
  });
}

describe("secureStreamDownload: incomplete bodies", () => {
  it("fails with a download-incomplete error and leaves no file when the connection closes early", async () => {
    const error = await save("/short").catch((e) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).kind).toBe("incomplete");
    expect((error as Error).message).toMatch(/download incomplete/i);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("fails when a stream ends cleanly but short of the stated length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(PDF.subarray(0, 100)));
        controller.close();
      },
    });
    const error = await secureStreamDownload({
      targetDir: dir, filename: "Notes.pdf", body, maxBytes: 10_000_000, expectedBytes: PDF.length,
    }).catch((e) => e);
    expect((error as DownloadError).kind).toBe("incomplete");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("saves a body that matches its Content-Length", async () => {
    const result = await save("/whole");
    expect(result.size).toBe(PDF.length);
    expect(await fs.readdir(dir)).toEqual(["Notes.pdf"]);
  });

  it("saves a body with no Content-Length", async () => {
    const result = await save("/chunked");
    expect(result.size).toBe(PDF.length);
  });
});
