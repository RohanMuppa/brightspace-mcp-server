import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { notifyApprovalNumber, resetApprovalNotifications } from "../../src/utils/notify.js";
import { AuthError } from "../../src/utils/errors.js";
import { parseSyncArgs, runSync, SYNC_USAGE } from "../../src/sync/sync-cli.js";
import { fakeBrightspace, fileTopic, module_, pdf, tempRoot, type Fake } from "./harness.js";

describe("sync --notify", () => {
  let parent: string;
  let dest: string;
  let fake: Fake;
  const toc = { Modules: [module_(1, "Week 1", [fileTopic(10, "/content/enforced/42-C/A.pdf"), fileTopic(11, "/content/enforced/42-C/B.pdf")])] };
  const notify = vi.fn(async () => true);

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    parent = await tempRoot();
    dest = path.join(parent, "dest");
    await fs.mkdir(dest);
    notify.mockClear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fake?.close();
    await fs.rm(parent, { recursive: true, force: true });
  });

  async function go(argv: string[], topics: Record<number, any>, extra: Record<string, unknown> = {}, tocOverride: unknown = toc) {
    fake = await fakeBrightspace(tocOverride, topics, extra);
    return runSync(["--course", "42", "--dest", dest, ...argv], { stdout: () => {}, stderr: () => {} }, { createClient: async () => fake.client, sleep: async () => {}, notify });
  }
  const files = { 10: { body: pdf("a") }, 11: { body: pdf("b") } };

  it("parses --notify and lists it in the help", () => {
    expect(parseSyncArgs(["--course", "1", "--dest", "/tmp/x", "--notify"])).toMatchObject({ notify: true });
    expect(parseSyncArgs(["--course", "1", "--dest", "/tmp/x"])).toMatchObject({ notify: false });
    expect(SYNC_USAGE).toContain("--notify");
  });

  it("says how many new files arrived, under the course's name", async () => {
    const lp = (p: string) => `/d2l/api/lp/1.50${p}`;
    fake = await fakeBrightspace(toc, files);
    fake.client.lp = lp;
    fake.client.get.mockImplementation(async (p: string) => {
      if (p === lp("/courses/42")) return { Name: "ECE 362: Microprocessors" };
      if (p.endsWith("/content/toc")) return toc;
      throw new Error("unexpected");
    });
    await runSync(["--course", "42", "--dest", dest, "--notify"], { stdout: () => {}, stderr: () => {} }, { createClient: async () => fake.client, sleep: async () => {}, notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: "Brightspace", message: "ECE 362: Microprocessors: 2 new files", openPath: dest });
  });

  it("falls back to the course id when the name cannot be read, and says 1 new file", async () => {
    await go(["--notify"], { 10: { body: pdf("a") }, 11: { status: 404 } });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "42: 1 new file" }));
  });

  it("says sign-in is needed when the run stopped for auth, and not the file count", async () => {
    const code = await go(["--notify"], { 10: { status: 401 }, 11: { body: pdf("b") } });
    expect(code).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: "Brightspace", message: "Brightspace sign-in needed" });
  });

  it("says sign-in is needed when no client could be made because the sign-in failed", async () => {
    const code = await runSync(["--course", "42", "--dest", dest, "--notify"], { stdout: () => {}, stderr: () => {} }, {
      createClient: async () => { throw new AuthError("expired"); }, notify,
    });
    expect(code).toBe(1);
    expect(notify).toHaveBeenCalledWith({ title: "Brightspace", message: "Brightspace sign-in needed" });
  });

  it("stays quiet when nothing changed", async () => {
    await go(["--notify"], files);
    notify.mockClear();
    const code = await go(["--notify"], files);
    expect(code).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("stays quiet on a dry run and without --notify", async () => {
    await go(["--notify", "--dry-run"], files);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(dest);
    await go([], files);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a notifier that rejects does not change the exit code", async () => {
    notify.mockRejectedValueOnce(new Error("no"));
    expect(await go(["--notify"], files)).toBe(0);
  });

  it("keeps the file count in the message when the course name is very long", async () => {
    const lp = (p: string) => `/d2l/api/lp/1.50${p}`;
    fake = await fakeBrightspace(toc, files);
    fake.client.lp = lp;
    fake.client.get.mockImplementation(async (p: string) => {
      if (p === lp("/courses/42")) return { Name: "N".repeat(500) };
      if (p.endsWith("/content/toc")) return toc;
      throw new Error("unexpected");
    });
    await runSync(["--course", "42", "--dest", dest, "--notify"], { stdout: () => {}, stderr: () => {} }, { createClient: async () => fake.client, sleep: async () => {}, notify });
    const message = (notify.mock.calls[0] as unknown as [{ message: string }])[0].message;
    expect(Array.from(message.split(":")[0]).length).toBeLessThanOrEqual(120);
    expect(message.endsWith("2 new files")).toBe(true);
  });

  it("does not show an approval number for a sign-in it abandons, and lifts that when it is done", async () => {
    resetApprovalNotifications();
    const run = vi.fn(async () => {});
    const deps = { platform: "darwin" as const, env: {}, run };
    let during: boolean | undefined;
    await runSync(["--course", "42", "--dest", dest, "--notify"], { stdout: () => {}, stderr: () => {} }, {
      createClient: async () => { during = await notifyApprovalNumber("55", deps); throw new AuthError("expired"); }, notify,
    });
    expect(during).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(await notifyApprovalNumber("55", deps)).toBe(true);
  });
});
