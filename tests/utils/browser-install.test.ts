import { describe, it, expect } from "vitest";
import { isMissingBrowserError, PLAYWRIGHT_INSTALL_HINT } from "../../src/utils/browser-install.js";

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
