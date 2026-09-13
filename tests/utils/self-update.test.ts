import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  passthroughFlags,
  shouldReexec,
  reexecLatestIfStale,
  REEXEC_SENTINEL,
} from "../../src/utils/self-update.js";

/**
 * A stale auth CLI must re-run itself through the current release without
 * asking the user anything, and must never recurse or strand the user when
 * npx is unavailable.
 */

const okJson = (version: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ version }),
});

/** A fake child process that exits with `code` on the next tick. */
function fakeChild(code: number | null, emit: "exit" | "error" = "exit") {
  const child = new EventEmitter() as EventEmitter & { unref?: () => void };
  queueMicrotask(() => {
    if (emit === "error") child.emit("error", new Error("ENOENT"));
    else child.emit("exit", code);
  });
  return child;
}

describe("passthroughFlags", () => {
  it("forwards option flags", () => {
    expect(passthroughFlags(["node", "auth-cli.js", "--automatic"])).toEqual(["--automatic"]);
  });

  it("drops positional arguments so the subcommand cannot be changed", () => {
    expect(passthroughFlags(["node", "auth-cli.js", "auth", "setup"])).toEqual([]);
    expect(passthroughFlags(["node", "auth-cli.js", "auth", "--automatic"])).toEqual(["--automatic"]);
  });
});

describe("shouldReexec", () => {
  const base = {
    env: {} as NodeJS.ProcessEnv,
    latest: "2.0.0",
    installedVersion: "1.0.0",
    runningFromNpxCache: false,
  };

  it("re-execs when a newer version exists", () => {
    expect(shouldReexec(base)).toBe(true);
  });

  it("never recurses into itself", () => {
    expect(shouldReexec({ ...base, env: { [REEXEC_SENTINEL]: "1" } })).toBe(false);
  });

  it("respects D2L_NO_UPDATE_CHECK", () => {
    expect(shouldReexec({ ...base, env: { D2L_NO_UPDATE_CHECK: "1" } })).toBe(false);
  });

  it("does nothing when npx already fetched latest", () => {
    expect(shouldReexec({ ...base, runningFromNpxCache: true })).toBe(false);
  });

  it("stays put when the registry is unreachable", () => {
    expect(shouldReexec({ ...base, latest: null })).toBe(false);
  });

  it("stays put when already current or ahead", () => {
    expect(shouldReexec({ ...base, latest: "1.0.0" })).toBe(false);
    expect(shouldReexec({ ...base, latest: "0.9.0" })).toBe(false);
  });
});

describe("reexecLatestIfStale", () => {
  it("runs the pinned latest command and returns the child's exit code", async () => {
    const spawnImpl = vi.fn(() => fakeChild(0)) as never;

    const code = await reexecLatestIfStale({
      env: {},
      argv: ["node", "auth-cli.js", "--automatic"],
      installedVersion: "1.2.6",
      fetchImpl: vi.fn(async () => okJson("2.0.0")) as unknown as typeof fetch,
      runningFromNpxCache: false,
      platform: "darwin",
      spawnImpl,
    });

    expect(code).toBe(0);
    const [command, args, options] = (spawnImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(command).toBe("npx");
    expect(args).toEqual(["-y", "brightspace-mcp-server@latest", "auth", "--automatic"]);
    expect(options.env[REEXEC_SENTINEL]).toBe("1");
  });

  it("propagates a non-zero exit code", async () => {
    const code = await reexecLatestIfStale({
      env: {},
      argv: ["node", "auth-cli.js"],
      installedVersion: "1.2.6",
      fetchImpl: vi.fn(async () => okJson("2.0.0")) as unknown as typeof fetch,
      runningFromNpxCache: false,
      spawnImpl: vi.fn(() => fakeChild(3)) as never,
    });
    expect(code).toBe(3);
  });

  it("falls back to running in place when npx cannot start", async () => {
    const code = await reexecLatestIfStale({
      env: {},
      argv: ["node", "auth-cli.js"],
      installedVersion: "1.2.6",
      fetchImpl: vi.fn(async () => okJson("2.0.0")) as unknown as typeof fetch,
      runningFromNpxCache: false,
      spawnImpl: vi.fn(() => fakeChild(null, "error")) as never,
    });
    expect(code).toBeNull();
  });

  it("does not touch the network when opted out", async () => {
    const fetchImpl = vi.fn();
    const spawnImpl = vi.fn();

    const code = await reexecLatestIfStale({
      env: { D2L_NO_UPDATE_CHECK: "1" },
      installedVersion: "1.2.6",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: spawnImpl as never,
    });

    expect(code).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does not re-exec when it is already the re-executed child", async () => {
    const spawnImpl = vi.fn();
    const code = await reexecLatestIfStale({
      env: { [REEXEC_SENTINEL]: "1" },
      installedVersion: "1.2.6",
      fetchImpl: vi.fn(async () => okJson("2.0.0")) as unknown as typeof fetch,
      spawnImpl: spawnImpl as never,
    });
    expect(code).toBeNull();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does not re-exec when already running from an npx cache", async () => {
    const spawnImpl = vi.fn();
    const code = await reexecLatestIfStale({
      env: {},
      installedVersion: "1.2.6",
      runningFromNpxCache: true,
      fetchImpl: vi.fn(async () => okJson("2.0.0")) as unknown as typeof fetch,
      spawnImpl: spawnImpl as never,
    });
    expect(code).toBeNull();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("uses npx.cmd on Windows", async () => {
    const spawnImpl = vi.fn(() => fakeChild(0)) as never;
    await reexecLatestIfStale({
      env: {},
      argv: ["node", "auth-cli.js"],
      installedVersion: "1.2.6",
      fetchImpl: vi.fn(async () => okJson("2.0.0")) as unknown as typeof fetch,
      runningFromNpxCache: false,
      platform: "win32",
      spawnImpl,
    });
    const [command, , options] = (spawnImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [string, string[], { shell: boolean }];
    expect(command).toBe("npx.cmd");
    expect(options.shell).toBe(true);
  });
});
