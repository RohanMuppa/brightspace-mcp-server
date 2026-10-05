import { describe, it, expect, afterEach } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import type { TokenManager } from "../../src/auth/token-manager.js";

/**
 * The request timeout guards against a server that stops answering, not
 * against a large file. A download whose body keeps arriving must be allowed
 * to finish however long it takes; one that stops arriving must still fail.
 */

const TIMEOUT_MS = 100;
const originalFetch = global.fetch;

const tokenManager = {
  async getToken() {
    return { accessToken: "t", capturedAt: Date.now(), expiresAt: Date.now() + 3_600_000, source: "browser" };
  },
  async setToken() {},
  async clearToken() {},
  isValid() {
    return true;
  },
  async needsRefresh() {
    return false;
  },
} as unknown as TokenManager;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A body that delivers `chunks` pieces `gapMs` apart, then optionally stalls. Like
 * fetch, it errors as soon as the request's signal aborts. */
function slowBody(signal: AbortSignal, chunks: number, gapMs: number, stallAfter = false) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason));
    },
    async pull(controller) {
      if (sent === chunks) {
        if (stallAfter) return new Promise<void>(() => {});
        controller.close();
        return;
      }
      await sleep(gapMs);
      if (signal.aborted) return;
      sent++;
      controller.enqueue(new Uint8Array(1024).fill(sent));
    },
  });
}

async function clientServing(body: (signal: AbortSignal) => ReadableStream<Uint8Array>) {
  global.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).includes("/d2l/api/versions/")) {
      return new Response(
        JSON.stringify([{ ProductCode: "lp", LatestVersion: "1.62" }, { ProductCode: "le", LatestVersion: "1.96" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(body(init.signal!), { status: 200, headers: { "content-type": "application/pdf" } });
  }) as typeof fetch;
  const client = new D2LApiClient({
    baseUrl: "https://purdue.brightspace.com",
    tokenManager,
    timeoutMs: TIMEOUT_MS,
    retry: { maxAttempts: 1 },
  });
  await client.initialize();
  return client;
}

describe("getRaw body timeout", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("finishes a body that keeps arriving for longer than the request timeout", async () => {
    const client = await clientServing(signal => slowBody(signal, 6, TIMEOUT_MS / 2));

    const response = await client.getRaw("/d2l/api/le/1.96/1/content/topics/2/file");
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(bytes.length).toBe(6 * 1024);
    expect(bytes[bytes.length - 1]).toBe(6);
  });

  it("fails a body that stops arriving for longer than the request timeout", async () => {
    const client = await clientServing(signal => slowBody(signal, 1, 10, true));

    const response = await client.getRaw("/d2l/api/le/1.96/1/content/topics/2/file");

    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});
