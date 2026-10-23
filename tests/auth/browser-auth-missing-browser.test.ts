import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserAuth } from "../../src/auth/browser-auth.js";
import { playwrightCliPath } from "../../src/utils/browser-install.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Disk cleanup can delete Playwright's browser cache long after a good
 * install (issue #337). Sign-in must then name the repair that installs the
 * revision this server's own Playwright needs, and leave saved state alone.
 */

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), launch: vi.fn() }));
vi.mock("../../src/auth/browser-state-store.js", () => ({
  BrowserStateStore: class { load = mocks.load; save = mocks.save; },
}));
vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));

let directory: string;

function newAuth(): BrowserAuth {
  const config = {
    baseUrl: "https://school.example", sessionDir: directory, tokenTtl: 3600,
    headless: true, username: "student", password: "dummy", courseFilter: {},
  } as AppConfig;
  return new BrowserAuth(config, { onMfaChallenge: () => {} });
}

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-missing-browser-test-"));
  mocks.load.mockResolvedValue({ cookies: [{ name: "saved" }], origins: [] });
  mocks.launch.mockRejectedValue(new Error(
    "browserType.launch: Executable doesn't exist at /cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell",
  ));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("BrowserAuth with its browser cache deleted after install", () => {
  it("fails as browser_missing with this package's own Playwright install command", async () => {
    const error = await newAuth().authenticate().catch((e: unknown) => e as Error & { step?: string });
    expect(error.step).toBe("browser_missing");
    expect(error.message).toContain(`"${playwrightCliPath()}" install chromium`);
  });

  it("does not overwrite the saved sign-in state", async () => {
    await newAuth().authenticate().catch(() => {});
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
