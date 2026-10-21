import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  chromiumReady,
  chromiumStatus,
  installChromium,
  isMissingBrowserError,
  playwrightCliPath,
  PLAYWRIGHT_INSTALL_HINT,
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

  it("matches a bare install instruction", () => {
    expect(isMissingBrowserError(new Error("please run npx playwright install chromium"))).toBe(true);
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
    expect(PLAYWRIGHT_INSTALL_HINT).toContain("npx playwright install chromium");
  });

  it("explains why the browser is missing, not just what to run", () => {
    expect(PLAYWRIGHT_INSTALL_HINT).toMatch(/postinstall/i);
    expect(PLAYWRIGHT_INSTALL_HINT).toMatch(/ignore-scripts|allow-scripts/i);
  });
});

describe("chromiumStatus", () => {
  const missing = new Error("browserType.launch: Executable doesn't exist at /x/chrome-headless-shell");

  it("is ready when both browsers are there", async () => {
    const status = await chromiumStatus({ launchHeadless: async () => {}, executablePath: async () => "/x/chrome", existsSync: () => true });
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
    const status = await chromiumStatus({ launchHeadless: async () => {}, executablePath: async () => "/x/chrome", existsSync: () => false });
    expect(chromiumReady(status)).toBe(false);
  });

  it("doesn't call a launch blocked for another reason a missing browser", async () => {
    const status = await chromiumStatus({
      launchHeadless: async () => { throw new Error("sandbox_host_linux.cc: Operation not permitted\nmore"); },
      executablePath: async () => "/x/chrome",
      existsSync: () => true,
    });
    expect(status).toEqual({ headless: "unknown", visible: true, detail: "sandbox_host_linux.cc: Operation not permitted" });
    expect(chromiumReady(status)).toBe(true);
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
      options: { stdio: ["ignore", 2, 2] },
    }]);
  });

  it("reports a failed install", async () => {
    expect(await installChromium({ spawnImpl: fakeSpawn(1).spawnImpl, cliPath: "/cli.js" })).toMatchObject({ ok: false });
    expect(await installChromium({ spawnImpl: fakeSpawn(null, new Error("ENOENT")).spawnImpl, cliPath: "/cli.js" }))
      .toEqual({ ok: false, message: "ENOENT" });
  });

  it("finds the Playwright CLI this package depends on", () => {
    expect(playwrightCliPath()).toMatch(/node_modules[\\/]playwright[\\/]cli\.js$/);
  });
});
