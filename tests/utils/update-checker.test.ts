import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The update checker runs on every server start. It may look, and it may
 * tell the user what it found. It must never install anything or spawn a
 * process, and it must be possible to switch off entirely.
 */

vi.mock("node:child_process", () => ({
  exec: vi.fn(() => {
    throw new Error("exec must not be called by the update checker");
  }),
  execFile: vi.fn(() => {
    throw new Error("execFile must not be called by the update checker");
  }),
  spawn: vi.fn(() => {
    throw new Error("spawn must not be called by the update checker");
  }),
}));

import * as childProcess from "node:child_process";
import {
  isNewerVersion,
  initUpdateChecker,
  getUpdateNotice,
} from "../../src/utils/update-checker.js";

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe("isNewerVersion", () => {
  it("is true only when latest is strictly newer", () => {
    expect(isNewerVersion("1.5.2", "1.5.1")).toBe(true);
    expect(isNewerVersion("1.6.0", "1.5.9")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerVersion("1.5.1", "1.5.1")).toBe(false);
    expect(isNewerVersion("1.5.0", "1.5.1")).toBe(false);
    expect(isNewerVersion("1.4.9", "1.5.0")).toBe(false);
  });

  it("compares numerically, not as strings", () => {
    expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
    expect(isNewerVersion("1.9.0", "1.10.0")).toBe(false);
  });

  it("ignores prerelease suffixes and refuses garbage", () => {
    expect(isNewerVersion("1.5.2-beta.1", "1.5.1")).toBe(true);
    expect(isNewerVersion("1.5.1-rc.1", "1.5.1")).toBe(false);
    expect(isNewerVersion("latest", "1.5.1")).toBe(false);
    expect(isNewerVersion("", "1.5.1")).toBe(false);
  });
});

describe("initUpdateChecker", () => {
  beforeEach(() => {
    getUpdateNotice();
    vi.clearAllMocks();
  });

  it("does nothing at all when D2L_NO_UPDATE_CHECK is set", async () => {
    const fetchImpl = vi.fn();
    await initUpdateChecker({
      fetchImpl,
      env: { D2L_NO_UPDATE_CHECK: "1" },
      installedVersion: "1.0.0",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getUpdateNotice()).toBeNull();
  });

  it("swallows a failed registry lookup silently", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("timeout");
    });
    await expect(
      initUpdateChecker({ fetchImpl, env: {}, installedVersion: "1.0.0" })
    ).resolves.toBeUndefined();
    expect(getUpdateNotice()).toBeNull();
  });

  it("stays quiet when the registry is not newer", async () => {
    const fetchImpl = vi.fn(async () => okJson({ version: "1.0.0" }));
    await initUpdateChecker({ fetchImpl, env: {}, installedVersion: "1.0.0" });
    expect(getUpdateNotice()).toBeNull();

    const older = vi.fn(async () => okJson({ version: "0.9.0" }));
    await initUpdateChecker({ fetchImpl: older, env: {}, installedVersion: "1.0.0" });
    expect(getUpdateNotice()).toBeNull();
  });

  it("only tells the user about a newer version, never installs it", async () => {
    const fetchImpl = vi.fn(async () => okJson({ version: "2.0.0" }));
    const clearCaches = vi.fn(async () => 0);
    await initUpdateChecker({
      fetchImpl,
      env: {},
      installedVersion: "1.0.0",
      runningFromNpxCache: false,
      clearCaches,
    });

    const notice = getUpdateNotice();
    expect(notice).toContain("v1.0.0");
    expect(notice).toContain("v2.0.0");
    expect(notice).toMatch(/npm install -g brightspace-mcp-server@latest/);
    expect(clearCaches).not.toHaveBeenCalled();
    expect(childProcess.exec).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("clears only this package's stale npx caches and says so", async () => {
    const fetchImpl = vi.fn(async () => okJson({ version: "2.0.0" }));
    const clearCaches = vi.fn(async () => 2);
    await initUpdateChecker({
      fetchImpl,
      env: {},
      installedVersion: "1.0.0",
      runningFromNpxCache: true,
      clearCaches,
    });

    const notice = getUpdateNotice();
    expect(clearCaches).toHaveBeenCalledOnce();
    expect(notice).toContain("2");
    expect(notice).toMatch(/npx cache/i);
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  it("hands the notice out once", async () => {
    const fetchImpl = vi.fn(async () => okJson({ version: "2.0.0" }));
    await initUpdateChecker({
      fetchImpl,
      env: {},
      installedVersion: "1.0.0",
      runningFromNpxCache: false,
    });
    expect(getUpdateNotice()).not.toBeNull();
    expect(getUpdateNotice()).toBeNull();
  });

  it("asks the registry with a bounded timeout", async () => {
    const fetchImpl = vi.fn(async () => okJson({ version: "1.0.0" }));
    await initUpdateChecker({ fetchImpl, env: {}, installedVersion: "1.0.0" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://registry.npmjs.org/brightspace-mcp-server/latest");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
