import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  chromiumReady,
  chromiumStatus,
  installChromium,
  isMissingBrowserError,
  playwrightCliPath,
  PLAYWRIGHT_INSTALL_HINT,
  launchWithBrowserRecovery,
  BrowserInstallError,
} from "../../src/utils/browser-install.js";

/**
 * A global install done with --ignore-scripts, or under npm's allow-scripts
 * policy, silently skips the Chromium download. Sign-in then fails with a
 * message that gets flattened into a generic "Authentication failed" further
 * up. This predicate is what keeps the actual remedy attached to the error.
 */

describe("isMissingBrowserError", () => {
  it("matches Playwright's missing-executable error", () => {
    const real = new Error(
      "browserType.launch: Executable doesn't exist at " +
      "/Users/me/Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium.app\n" +
      "╔═══════════════════════════════════════════════════════════════════════════╗\n" +
      "║ Looks like Playwright was just installed or updated.                      ║\n" +
      "║ Please run the following command to download new browsers:                ║\n" +
      "║     npx playwright install                                                ║\n" +
      "╚═══════════════════════════════════════════════════════════════════════════╝"
    );
    expect(isMissingBrowserError(real)).toBe(true);
  });

  it("does not guess a missing executable from installation advice alone", () => {
    expect(isMissingBrowserError(new Error("please run npx playwright install chromium"))).toBe(false);
    expect(isMissingBrowserError(new Error("Host system is missing dependencies. Run npx playwright install-deps"))).toBe(false);
  });

  it("accepts a string as well as an Error", () => {
    expect(isMissingBrowserError("Executable doesn't exist at /path")).toBe(true);
  });

  it("does not match unrelated launch failures", () => {
    expect(isMissingBrowserError(new Error("Timeout 60000ms exceeded"))).toBe(false);
    expect(isMissingBrowserError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(false);
    expect(isMissingBrowserError(new Error("Target page, context or browser has been closed"))).toBe(false);
  });

  it("is safe on empty and non-error input", () => {
    expect(isMissingBrowserError(null)).toBe(false);
    expect(isMissingBrowserError(undefined)).toBe(false);
    expect(isMissingBrowserError({})).toBe(false);
    expect(isMissingBrowserError("")).toBe(false);
  });
});

describe("PLAYWRIGHT_INSTALL_HINT", () => {
  it("names the command that actually fixes it", () => {
    expect(PLAYWRIGHT_INSTALL_HINT).toContain(" repair");
    expect(PLAYWRIGHT_INSTALL_HINT).not.toContain("npx playwright");
  });

  it("explains why the browser is missing, not just what to run", () => {
    expect(PLAYWRIGHT_INSTALL_HINT).toContain("removed after installation");
    expect(PLAYWRIGHT_INSTALL_HINT).toContain("skipped");
  });
});

describe("chromiumStatus", () => {
  const missing = new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell");

  it("is ready when both browsers are there", async () => {
    const status = await chromiumStatus({ launchHeadless: async () => { }, executablePath: async () => "/x/chrome", existsSync: () => true });
    expect(status).toEqual({ headless: "present", visible: true });
    expect(chromiumReady(status)).toBe(true);
  });

  it("is not ready when only the visible browser is installed", async () => {
    const status = await chromiumStatus({
      launchHeadless: async () => { throw missing; },
      executablePath: async () => "/x/chrome",
      existsSync: () => true,
    });
    expect(status).toEqual({ headless: "missing", visible: true });
    expect(chromiumReady(status)).toBe(false);
  });

  it("is not ready when only the headless shell is installed", async () => {
    const status = await chromiumStatus({ launchHeadless: async () => { }, executablePath: async () => "/x/chrome", existsSync: () => false });
    expect(chromiumReady(status)).toBe(false);
  });

  it("doesn't call a launch blocked for another reason a missing browser", async () => {
    const status = await chromiumStatus({
      launchHeadless: async () => { throw new Error("sandbox_host_linux.cc: Operation not permitted\nmore"); },
      executablePath: async () => "/x/chrome",
      existsSync: () => true,
    });
    expect(status).toEqual({ headless: "unknown", visible: true, detail: "sandbox_host_linux.cc: Operation not permitted" });
    expect(chromiumReady(status)).toBe(false);
  });
});

describe("launchWithBrowserRecovery", () => {
  const missing = new Error("Executable doesn't exist at /browser");
  it("installs only after a missing-browser failure and retries once", async () => {
    const launch = vi.fn().mockRejectedValueOnce(missing).mockResolvedValue("browser");
    const install = vi.fn(async () => ({ ok: true }));
    await expect(launchWithBrowserRecovery(launch, install, vi.fn())).resolves.toBe("browser");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledOnce();
  });
  it("never installs on healthy or unrelated failures", async () => {
    const install = vi.fn();
    await expect(launchWithBrowserRecovery(async () => "browser", install)).resolves.toBe("browser");
    await expect(launchWithBrowserRecovery(async () => { throw new Error("Permission denied"); }, install)).rejects.toThrow("Permission denied");
    expect(install).not.toHaveBeenCalled();
  });
  it("stops on failed installation or a still-missing browser", async () => {
    const launch = vi.fn().mockRejectedValue(missing);
    const install = vi.fn(async () => ({ ok: false }));
    await expect(launchWithBrowserRecovery(launch, install, vi.fn())).rejects.toBeInstanceOf(BrowserInstallError);
    expect(launch).toHaveBeenCalledOnce();
    install.mockResolvedValue({ ok: true });
    launch.mockClear();
    await expect(launchWithBrowserRecovery(launch, install, vi.fn())).rejects.toBeInstanceOf(BrowserInstallError);
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it("reports deleted dependency code without attempting a browser download", async () => {
    const install = vi.fn();
    const error = Object.assign(new Error("Cannot find package 'playwright'"), { code: "ERR_MODULE_NOT_FOUND" });
    await expect(launchWithBrowserRecovery(async () => { throw error; }, install)).rejects.toMatchObject({ dependencyMissing: true });
    expect(install).not.toHaveBeenCalled();
  });
});

describe("installChromium", () => {
  function fakeSpawn(code: number | null, error?: Error) {
    const calls: { command: string; args: string[]; options: unknown }[] = [];
    const spawnImpl = ((command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => (error ? child.emit("error", error) : child.emit("close", code)));
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    return { spawnImpl, calls };
  }

  it("runs this package's own Playwright CLI with node, not npx or a shell", async () => {
    const { spawnImpl, calls } = fakeSpawn(0);
    const result = await installChromium({ spawnImpl, execPath: "/usr/bin/node", cliPath: "/pkg/node_modules/playwright/cli.js" });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{
      command: "/usr/bin/node",
      args: ["/pkg/node_modules/playwright/cli.js", "install", "chromium"],
      options: { stdio: ["ignore", 2, 2], detached: process.platform !== "win32" },
    }]);
  });

  it("reports a failed install", async () => {
    expect(await installChromium({ spawnImpl: fakeSpawn(1).spawnImpl, cliPath: "/cli.js" })).toMatchObject({ ok: false });
    expect(await installChromium({ spawnImpl: fakeSpawn(null, new Error("ENOENT")).spawnImpl, cliPath: "/cli.js" }))
      .toEqual({ ok: false, message: "ENOENT" });
  });

  it("bounds an installer that never exits", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    try {
      const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
      const result = installChromium({ spawnImpl, cliPath: "/cli.js", timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toMatchObject({ ok: false, message: expect.stringContaining("timed out") });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close", null);
    } finally { vi.useRealTimers(); }
  });

  it("finds the Playwright CLI this package depends on", () => {
    expect(playwrightCliPath()).toMatch(/node_modules[\\/]playwright[\\/]cli\.js$/);
  });
});
