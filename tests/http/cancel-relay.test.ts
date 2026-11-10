import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime, type ServerRuntime } from "../../src/server.js";
import { runtimeDirectory, serveSharedRuntime, type SharedRuntime } from "../../src/shared-runtime.js";
import { relaySharedRuntime } from "../../src/runtime-relay.js";
import type { AppConfig } from "../../src/types/index.js";
import { fakeBrightspace, fileTopic, module_, pdf, type Fake } from "../sync/harness.js";

/**
 * In the default stdio mode every message is its own HTTP POST to the shared
 * runtime, so a client's notifications/cancelled had no way to reach the call
 * it named. The relay now aborts that call's POST, and the runtime ends the
 * tool's own signal when its request goes away.
 */
const config = (sessionDir: string): AppConfig => ({
  baseUrl: "https://fake-brightspace.test",
  sessionDir,
  tokenTtl: 3600,
  headless: true,
  envAccessToken: "fake-upstream-token",
  courseFilter: { activeOnly: true },
});

describe("cancelling a download_course_files call over the relay", { timeout: 30_000 }, () => {
  let sessionDir: string;
  let dest: string;
  let dir: string;
  let served: SharedRuntime[];
  let fake: Fake;
  let sawAbort: boolean;
  let hangs: boolean;
  const clients: Client[] = [];

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sessionDir = mkdtempSync(join(tmpdir(), "bs-cancel-"));
    dest = mkdtempSync(join(tmpdir(), "bs-cancel-dest-"));
    dir = runtimeDirectory(config(sessionDir), "test");
    served = [];
    sawAbort = false;
    hangs = true;
    const toc = { Modules: [module_(1, "M", [fileTopic(10, "/content/enforced/42-C/A.pdf"), fileTopic(11, "/content/enforced/42-C/B.pdf")])] };
    fake = await fakeBrightspace(toc, { 10: { body: pdf("a") }, 11: { body: pdf("b") } });
    const serve = fake.client.getRaw.getMockImplementation()!;
    fake.client.getRaw.mockImplementation((p: string, options?: { signal?: AbortSignal }) => {
      if (!hangs) return serve(p, options);
      // A slow Brightspace: never answers, but ends when the request is aborted, as fetch does.
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(options.signal!.reason);
        }, { once: true });
      });
    });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
    await Promise.all(served.splice(0).map((runtime) => runtime.stop()));
    await fake.close();
    vi.restoreAllMocks();
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  function startRuntime(): void {
    const runtime: ServerRuntime = createRuntime(config(sessionDir), "test");
    runtime.apiClient = fake.client;
    void serveSharedRuntime(runtime, { dir, idleMs: 60_000 }).then((shared) => {
      if (shared) served.push(shared);
    });
  }

  async function chat(): Promise<Client> {
    const client = new Client({ name: "chat", version: "1" });
    const [clientSide, relaySide] = InMemoryTransport.createLinkedPair();
    await relaySharedRuntime(relaySide, { dir, startRuntime });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  const call = (client: Client, signal?: AbortSignal) =>
    client.callTool({ name: "download_course_files", arguments: { courseId: 42, downloadPath: dest } }, undefined, { signal });

  it("stops the sync promptly, leaves no partial file or lock, and a follow-up call into the same folder works", async () => {
    const client = await chat();
    const controller = new AbortController();
    const pending = call(client, controller.signal);
    // Let the call reach Brightspace and hang there.
    await vi.waitFor(() => expect(fake.client.getRaw).toHaveBeenCalled(), { timeout: 10_000 });
    const cancelledAt = Date.now();
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(sawAbort).toBe(true), { timeout: 5_000 });
    expect(Date.now() - cancelledAt).toBeLessThan(5_000);

    // The run ended by itself: no lock and no partial download left in the folder.
    await vi.waitFor(async () => {
      expect((await fs.readdir(dest)).filter((name) => name.endsWith(".lock") || name.endsWith(".part") || name.startsWith(".download-"))).toEqual([]);
    }, { timeout: 5_000 });

    hangs = false;
    const again = await call(client);
    expect((again.content as Array<{ text: string }>)[0].text).toMatch(/2 downloaded/);
    expect(await fs.readdir(join(dest, "M"))).toEqual(["A.pdf", "B.pdf"]);
  });
});
