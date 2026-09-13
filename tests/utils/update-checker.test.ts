import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * The update checker runs on every server start and then periodically. It may
 * look, and it may tell the user what it found. It must never install anything
 * or spawn a process, it must never delete the directory it is running from,
 * and it must be possible to switch off entirely.
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
  startUpdateChecks,
  getUpdateNotice,
  peekUpdateNotice,
  clearUpdateNotice,
  clearAllNpxCaches,
  ownNpxCacheDir,
} from "../../src/utils/update-checker.js";

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/** Seed a pending notice for the global-install (non-npx) case. */
async function seedNotice(installed = "1.0.0", latest = "2.0.0") {
  await initUpdateChecker({
    fetchImpl: vi.fn(async () => okJson({ version: latest })) as unknown as typeof fetch,
    env: {},
    installedVersion: installed,
    runningFromNpxCache: false,
  });
}

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
    clearUpdateNotice();
    vi.clearAllMocks();
  });

  it("does nothing at all when D2L_NO_UPDATE_CHECK is set", async () => {
    const fetchImpl = vi.fn();
    await initUpdateChecker({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: { D2L_NO_UPDATE_CHECK: "1" },
      installedVersion: "1.0.0",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(peekUpdateNotice()).toBeNull();
  });

  it("swallows a failed registry lookup silently", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("timeout");
    });
    await expect(
      initUpdateChecker({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: {},
        installedVersion: "1.0.0",
      })
    ).resolves.toBeUndefined();
    expect(peekUpdateNotice()).toBeNull();
  });

  it("stays quiet when the registry is not newer", async () => {
    await seedNotice("1.0.0", "1.0.0");
    expect(peekUpdateNotice()).toBeNull();

    await seedNotice("1.0.0", "0.9.0");
    expect(peekUpdateNotice()).toBeNull();
  });

  it("only tells the user about a newer version, never installs it", async () => {
    const fetchImpl = vi.fn(async () => okJson({ version: "2.0.0" }));
    const clearCaches = vi.fn(async () => 0);
    await initUpdateChecker({
      fetchImpl: fetchImpl as unknown as typeof fetch,
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
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {},
      installedVersion: "1.0.0",
      runningFromNpxCache: true,
      clearCaches,
    });

    const notice = getUpdateNotice();
    expect(clearCaches).toHaveBeenCalledOnce();
    expect(notice).toContain("2");
    expect(notice).toMatch(/npx cache/i);
    expect(notice).toMatch(/kept the one this server is running from/i);
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  it("asks the registry with a bounded timeout", async () => {
    const fetchImpl = vi.fn(async () => okJson({ version: "1.0.0" }));
    await initUpdateChecker({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {},
      installedVersion: "1.0.0",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://registry.npmjs.org/brightspace-mcp-server/latest");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not reset the throttle when a repeat check finds the same version", async () => {
    await seedNotice();
    expect(getUpdateNotice(0)).not.toBeNull();

    // A later periodic check turning up the same version must not make the
    // notice repeat immediately.
    await seedNotice();
    expect(getUpdateNotice(1000)).toBeNull();
  });
});

describe("notice delivery", () => {
  beforeEach(() => {
    clearUpdateNotice();
    vi.clearAllMocks();
  });

  it("repeats on a throttle rather than being consumed once", async () => {
    await seedNotice();

    expect(getUpdateNotice(0)).not.toBeNull();
    expect(getUpdateNotice(1000)).toBeNull(); // too soon
    expect(getUpdateNotice(29 * 60 * 1000)).toBeNull(); // still too soon
    expect(getUpdateNotice(31 * 60 * 1000)).not.toBeNull(); // repeats
  });

  it("peek never consumes and is never throttled", async () => {
    await seedNotice();

    expect(peekUpdateNotice()).not.toBeNull();
    expect(peekUpdateNotice()).not.toBeNull();
    expect(peekUpdateNotice()).not.toBeNull();
    // and peeking left it available to the throttled reader
    expect(getUpdateNotice(0)).not.toBeNull();
  });

  it("clearUpdateNotice drops a pending notice", async () => {
    await seedNotice();
    expect(peekUpdateNotice()).not.toBeNull();

    clearUpdateNotice();
    expect(peekUpdateNotice()).toBeNull();
    expect(getUpdateNotice()).toBeNull();
  });
});

describe("ownNpxCacheDir", () => {
  it("finds the cache root when running from an npx cache", () => {
    expect(
      ownNpxCacheDir("/Users/me/.npm/_npx/abc123/node_modules/brightspace-mcp-server")
    ).toBe("/Users/me/.npm/_npx/abc123");
  });

  it("is null for a global install", () => {
    expect(ownNpxCacheDir("/usr/local/lib/node_modules/brightspace-mcp-server")).toBeNull();
  });

  it("is null for a local dev checkout", () => {
    expect(ownNpxCacheDir("/Users/me/Documents/brightspace-mcp-server")).toBeNull();
  });
});

describe("clearAllNpxCaches", () => {
  const root = resolve(homedir(), ".npm", "_npx");

  it("never deletes the directory the current process is running from", async () => {
    const rmImpl = vi.fn(async () => {});
    const selfDir = resolve(root, "bbb");

    const cleared = await clearAllNpxCaches(selfDir, {
      readdirImpl: (async () => ["aaa", "bbb", "ccc"]) as never,
      accessImpl: (async () => {}) as never,
      rmImpl: rmImpl as never,
    });

    const deleted = rmImpl.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(deleted).toContain(resolve(root, "aaa"));
    expect(deleted).toContain(resolve(root, "ccc"));
    expect(deleted).not.toContain(selfDir);
    expect(cleared).toBe(2);
  });

  it("leaves cache entries that do not hold this package alone", async () => {
    const rmImpl = vi.fn(async () => {});

    const cleared = await clearAllNpxCaches(null, {
      readdirImpl: (async () => ["mine", "someone-else"]) as never,
      accessImpl: (async (p: string) => {
        if (!p.includes("mine")) throw new Error("ENOENT");
      }) as never,
      rmImpl: rmImpl as never,
    });

    expect(rmImpl).toHaveBeenCalledOnce();
    expect(cleared).toBe(1);
  });

  it("survives a missing npx cache directory", async () => {
    const cleared = await clearAllNpxCaches(null, {
      readdirImpl: (async () => {
        throw new Error("ENOENT");
      }) as never,
    });
    expect(cleared).toBe(0);
  });
});

describe("startUpdateChecks", () => {
  beforeEach(() => {
    clearUpdateNotice();
    vi.clearAllMocks();
  });

  it("unrefs the interval so it cannot hold the process open", () => {
    const unref = vi.fn();
    const setIntervalImpl = vi.fn(() => ({ unref }));

    startUpdateChecks({
      fetchImpl: vi.fn(async () => okJson({ version: "1.0.0" })) as unknown as typeof fetch,
      env: { D2L_NO_UPDATE_CHECK: "1" },
      setIntervalImpl,
    });

    expect(setIntervalImpl).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
  });

  it("returns a stopper that clears the interval", () => {
    const handle = { unref: vi.fn() };
    const clearIntervalImpl = vi.fn();

    const stop = startUpdateChecks({
      env: { D2L_NO_UPDATE_CHECK: "1" },
      setIntervalImpl: vi.fn(() => handle),
      clearIntervalImpl,
    });
    stop();

    expect(clearIntervalImpl).toHaveBeenCalledWith(handle);
  });

  it("checks once immediately, then on the interval", async () => {
    const fetchImpl = vi.fn(async () => okJson({ version: "2.0.0" }));
    let tick: (() => void) | null = null;

    startUpdateChecks({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {},
      installedVersion: "1.0.0",
      runningFromNpxCache: false,
      setIntervalImpl: (fn) => {
        tick = fn;
        return { unref: vi.fn() };
      },
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    tick!();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  });
});
