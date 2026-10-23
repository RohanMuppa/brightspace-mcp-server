import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  chromiumReady,
  chromiumStatus,
  installChromium,
  isMissingBrowserError,
  playwrightCliPath,
  browserMissingHint,
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

describe("browserMissingHint", () => {
  const paths = { execPath: "/usr/local/bin/node", resolveCli: () => "/pkg/node_modules/playwright/cli.js" };

  it("gives the install command of this package's own Playwright, not npx's", () => {
    const hint = browserMissingHint(paths);
    expect(hint).toContain('"/usr/local/bin/node" "/pkg/node_modules/playwright/cli.js" install chromium');
    expect(hint).not.toContain("npx playwright");
  });

  it("explains a postinstall that was skipped", () => {
    expect(browserMissingHint(paths)).toMatch(/postinstall.*(ignore-scripts|allow-scripts)/i);
  });

  it("explains a browser removed after installation, such as by disk cleanup", () => {
    expect(browserMissingHint(paths)).toMatch(/removed after installation.*disk cleanup/i);
  });

  it("tells the person their saved sign-in is untouched", () => {
    expect(browserMissingHint(paths)).toMatch(/saved .*sign-in.* (kept|untouched)/i);
  });

  it("falls back to the package's prepare command when Playwright's CLI cannot be found", () => {
    const hint = browserMissingHint({ execPath: "/node", resolveCli: () => { throw new Error("Cannot find module"); } });
    expect(hint).toContain("npx -y brightspace-mcp-server@latest setup --prepare");
  });

  it("defaults to the running node and this package's Playwright CLI", () => {
    expect(browserMissingHint()).toContain(`"${process.execPath}" "${playwrightCliPath()}" install chromium`);
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
