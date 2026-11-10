import { afterEach, describe, expect, it } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import type { TokenManager } from "../../src/auth/token-manager.js";

/**
 * A caller that gives up (a cancelled tool call, a deadline) must be able to
 * interrupt a request that is hung, not just stop starting new ones.
 */
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

let hangingCalls = 0;
async function client(retry = { maxAttempts: 3, initialMs: 10, maxMs: 10 }) {
  hangingCalls = 0;
  global.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).includes("/d2l/api/versions/")) {
      return new Response(JSON.stringify([{ ProductCode: "lp", LatestVersion: "1.62" }, { ProductCode: "le", LatestVersion: "1.96" }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    hangingCalls++;
    // Never answers, but ends the moment the request's signal aborts, like fetch.
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }) as typeof fetch;
  const c = new D2LApiClient({ baseUrl: "https://purdue.brightspace.com", tokenManager, timeoutMs: 60_000, retry });
  await c.initialize();
  return c;
}

afterEach(() => {
  global.fetch = originalFetch;
});

describe("D2LApiClient abort signal", () => {
  it("interrupts a hung getRaw when the signal aborts, without retrying", async () => {
    const c = await client();
    const controller = new AbortController();
    const pending = c.getRaw("/d2l/api/le/1.96/1/content/topics/2/file", { signal: controller.signal });
    setTimeout(() => controller.abort("deadline"), 30);
    const started = Date.now();
    await expect(pending).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hangingCalls).toBe(1);
  });

  it("interrupts a hung get", async () => {
    const c = await client();
    const controller = new AbortController();
    const pending = c.get("/d2l/api/le/1.96/1/content/toc", { signal: controller.signal });
    setTimeout(() => controller.abort("cancelled"), 30);
    await expect(pending).rejects.toBeDefined();
    expect(hangingCalls).toBe(1);
  });

  it("does not start a request when the signal is already aborted", async () => {
    const c = await client();
    await expect(c.getRaw("/d2l/api/le/1.96/1/content/topics/2/file", { signal: AbortSignal.abort("x") })).rejects.toBeDefined();
    expect(hangingCalls).toBe(0);
  });

  it("one caller's abort does not cancel another caller's identical request", async () => {
    const c = await client({ maxAttempts: 1, initialMs: 1, maxMs: 1 });
    const controller = new AbortController();
    const a = c.get("/d2l/api/le/1.96/1/content/toc", { signal: controller.signal });
    const b = c.get("/d2l/api/le/1.96/1/content/toc");
    const outcome = Promise.race([b.then(() => "answered", () => "failed"), new Promise((r) => setTimeout(() => r("still waiting"), 80))]);
    controller.abort("cancelled");
    await expect(a).rejects.toBeDefined();
    expect(await outcome).toBe("still waiting");
  });
});
