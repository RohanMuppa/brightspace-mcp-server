/**
 * Brightspace MCP Server. Copyright (c) 2026 Rohan Muppa. MIT licensed.
 *
 * Browser downloads are disposable; installed dependency code is not.
 * Repair downloads through this installation's own Playwright CLI. Sign-in
 * repairs only a missing executable and retries once; it never runs npm.
 */

import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Run the installation that reported the error, even from another project. */
export const BROWSER_REPAIR_COMMAND = `node "${fileURLToPath(new URL("../index.js", import.meta.url)).replaceAll("\\", "/")}" repair`;

export function dependencyRepairHint(): string {
  const root = fileURLToPath(new URL("../../", import.meta.url)).replaceAll("\\", "/");
  const reinstall = root.split("/").includes("node_modules")
    ? `npm install --prefix "${root}" --omit=dev`
    : `npm ci --prefix "${root}", then npm run build in that directory`;
  return "Playwright's package code is missing. Restore this installation's declared dependencies with " +
    `${reinstall}, then run: ${BROWSER_REPAIR_COMMAND}`;
}

export class BrowserInstallError extends Error {
  constructor(readonly dependencyMissing = false) {
    super(dependencyMissing ? dependencyRepairHint() : PLAYWRIGHT_INSTALL_HINT);
    this.name = "BrowserInstallError";
  }
}

export function isMissingPlaywrightError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    /playwright/.test(error instanceof Error ? error.message : "");
}

export const PLAYWRIGHT_INSTALL_HINT =
  "Chromium is missing or could not be restored. It may have been removed after installation, " +
  `or the install script may have been skipped. Run: ${BROWSER_REPAIR_COMMAND}`;

/** True when an error is Playwright reporting that no browser binary exists. */
export function isMissingBrowserError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  return /Executable doesn't exist|Failed to launch.*because executable doesn't exist/i.test(
    message
  );
}

export interface ChromiumStatus {
  /**
   * The browser background sign-in uses (Playwright's headless shell),
   * found by really launching it. "unknown" means the launch failed for a
   * reason other than a missing browser, such as an agent's sandbox.
   */
  headless: "present" | "missing" | "unknown" | "dependency_missing";
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
    if (isMissingPlaywrightError(error)) {
      headless = "dependency_missing";
    } else if (isMissingBrowserError(error)) {
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
  return status.headless === "present" && status.visible;
}

/** One repair and one retry; unrelated launch failures never download anything.
 * Authentication already holds its process lock; Playwright's installer also
 * locks the shared browser cache across installations and accounts.
 */
export async function launchWithBrowserRecovery<T>(
  launch: () => Promise<T>,
  install: () => Promise<{ ok: boolean }> = installChromium,
  progress: () => void = () => console.error("Restoring Chromium for Brightspace sign-in..."),
): Promise<T> {
  try {
    return await launch();
  } catch (error) {
    if (isMissingPlaywrightError(error)) throw new BrowserInstallError(true);
    if (!isMissingBrowserError(error)) throw error;
  }
  progress();
  let installed: { ok: boolean };
  try { installed = await install(); } catch { throw new BrowserInstallError(); }
  if (!installed.ok) throw new BrowserInstallError();
  try {
    return await launch();
  } catch (error) {
    if (isMissingPlaywrightError(error)) throw new BrowserInstallError(true);
    if (isMissingBrowserError(error)) throw new BrowserInstallError();
    throw error;
  }
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
  timeoutMs?: number;
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
    const child = spawnImpl(execPath, [cliPath, "install", "chromium"], {
      stdio: ["ignore", 2, 2], detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      // Include Playwright's download worker, so a timeout cannot leave an
      // orphan downloading into the cache or holding its installation lock.
      try {
        if (child.pid && process.platform === "win32") {
          execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", timeout: 5000 });
        } else if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
      resolve({ ok: false, message: "Chromium installation timed out. Check your connection and run repair again." });
    }, options.timeoutMs ?? 120_000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
    child.once("error", () => clearTimeout(timer));
    child.once("error", (error) => resolve({ ok: false, message: error.message }));
    child.once("close", (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, message: `Playwright's installer exited with code ${code}.` }));
  });
}
