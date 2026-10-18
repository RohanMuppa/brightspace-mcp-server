/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * Recognising a missing Playwright browser.
 *
 * This package's postinstall downloads Chromium. npm skips postinstall under
 * `--ignore-scripts` and under the newer allow-scripts policy, both of which
 * are common on global installs, so the package can land without a browser and
 * fail only later, at first sign-in.
 *
 * Playwright's own message does say what to run, but by the time it has been
 * wrapped in BrowserAuthError and then flattened into a generic
 * "Authentication failed" by the auth runner, the actionable command is gone.
 * Matching the error lets us keep the fix attached to the failure.
 *
 * Sign-in matches reactively, so it never reports a missing browser unless a
 * launch really failed. `setup --prepare` and `doctor` check up front instead
 * (chromiumStatus), through Playwright's public API only, and prepare installs
 * a missing browser with the package's own Playwright (installChromium).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { CLEAR_NPX_CACHE_COMMAND } from "./commands.js";

export const PLAYWRIGHT_INSTALL_HINT =
  "Chromium is not installed, so sign-in cannot start. Your package manager " +
  "skipped this package's postinstall script, which is what normally downloads it " +
  "(common with --ignore-scripts or an allow-scripts policy). Run: " +
  "npx playwright install chromium" +
  `. If that does not help, reinstall and clear caches with ${CLEAR_NPX_CACHE_COMMAND}.`;

/** True when an error is Playwright reporting that no browser binary exists. */
export function isMissingBrowserError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  return /Executable doesn't exist|playwright install|Failed to launch.*because executable doesn't exist/i.test(
    message
  );
}

export interface ChromiumStatus {
  /**
   * The browser background sign-in uses (Playwright's headless shell),
   * found by really launching it. "unknown" means the launch failed for a
   * reason other than a missing browser, such as an agent's sandbox.
   */
  headless: "present" | "missing" | "unknown";
  /** The full browser that "show me the sign-in page" opens. */
  visible: boolean;
  /** Why `headless` is "unknown". */
  detail?: string;
}

export interface ChromiumProbe {
  launchHeadless: () => Promise<void>;
  executablePath: () => Promise<string>;
  existsSync: (p: string) => boolean;
}

const defaultProbe: ChromiumProbe = {
  async launchHeadless() {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, timeout: 30000 });
    await browser.close();
  },
  async executablePath() {
    const { chromium } = await import("playwright");
    return chromium.executablePath();
  },
  existsSync: fs.existsSync,
};

/** Whether both browsers sign-in can use are installed. Never opens a window. */
export async function chromiumStatus(overrides: Partial<ChromiumProbe> = {}): Promise<ChromiumStatus> {
  const probe = { ...defaultProbe, ...overrides };
  let headless: ChromiumStatus["headless"] = "present";
  let detail: string | undefined;
  try {
    await probe.launchHeadless();
  } catch (error) {
    if (isMissingBrowserError(error)) {
      headless = "missing";
    } else {
      headless = "unknown";
      detail = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
    }
  }
  let visible = false;
  try {
    visible = probe.existsSync(await probe.executablePath());
  } catch {
    visible = false;
  }
  return { headless, visible, ...(detail ? { detail } : {}) };
}

/** True when sign-in has every browser it might need. */
export function chromiumReady(status: ChromiumStatus): boolean {
  return status.headless !== "missing" && status.visible;
}

/** The CLI of the Playwright this package depends on, so the browser revision matches. */
export function playwrightCliPath(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
}

export interface InstallChromiumOptions {
  spawnImpl?: typeof spawn;
  execPath?: string;
  cliPath?: string;
}

/**
 * Download Chromium with the package's own Playwright: `npx playwright` can
 * resolve a different Playwright whose browser this package can't launch,
 * and needs a shell on Windows. Never `--with-deps`, which needs sudo on
 * Linux. Progress goes to stderr; stdin is closed so nothing can prompt.
 */
export function installChromium(options: InstallChromiumOptions = {}): Promise<{ ok: boolean; message?: string }> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const execPath = options.execPath ?? process.execPath;
  let cliPath: string;
  try {
    cliPath = options.cliPath ?? playwrightCliPath();
  } catch (error) {
    return Promise.resolve({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
  return new Promise((resolve) => {
    const child = spawnImpl(execPath, [cliPath, "install", "chromium"], { stdio: ["ignore", 2, 2] });
    child.once("error", (error) => resolve({ ok: false, message: error.message }));
    child.once("close", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, message: `Playwright's installer exited with code ${code}.` }));
  });
}
