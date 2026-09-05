import { describe, it, expect, vi } from "vitest";
import { needsVisibleBrowser, HeadlessLoginRequiredError } from "../../src/auth/browser-auth.js";

/**
 * Headless is fine for the silent path, where nothing is shown to anybody.
 * It is not fine for a credential login, because Purdue's Entra tenant ends
 * that flow with a number match: two digits appear on the page and the human
 * types them into Authenticator. With no window there is nowhere for those
 * digits to appear, and the log they are written to is a file the user has no
 * reason to open. The login then fails on a timeout that looks like a bug.
 *
 * So a headless run that discovers it needs a real login relaunches visible.
 */

describe("needsVisibleBrowser", () => {
  it("is true for a credential login that was launched headless", () => {
    expect(needsVisibleBrowser({ launchedHeadless: true })).toBe(true);
  });

  it("is false when the browser is already visible", () => {
    expect(needsVisibleBrowser({ launchedHeadless: false })).toBe(false);
  });
});

describe("HeadlessLoginRequiredError", () => {
  it("names the reason so the relaunch is not confused with a real failure", () => {
    const error = new HeadlessLoginRequiredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("HeadlessLoginRequiredError");
    expect(error.message).toMatch(/visible/i);
  });
});

describe("the relaunch decision", () => {
  /**
   * A tiny stand-in for authenticate()'s retry: launch, drive, and on the
   * sentinel relaunch once with headless off. This pins the control flow
   * without needing a browser.
   */
  async function driveWithRelaunch(
    configuredHeadless: boolean,
    outcomes: Array<"needs-visible-login" | "ok">
  ) {
    const launches: boolean[] = [];
    let attempt = 0;
    let headless = configuredHeadless;

    for (let i = 0; i < 2; i++) {
      launches.push(headless);
      const outcome = outcomes[attempt++];
      if (outcome === "needs-visible-login") {
        if (!headless) throw new Error("cannot relaunch: already visible");
        headless = false;
        continue;
      }
      return { launches, result: outcome };
    }
    throw new Error("relaunched more than once");
  }

  it("relaunches visible when a headless run turns out to need a login", async () => {
    const { launches, result } = await driveWithRelaunch(true, ["needs-visible-login", "ok"]);
    expect(launches).toEqual([true, false]);
    expect(result).toBe("ok");
  });

  it("does not relaunch when the silent path succeeds headless", async () => {
    const { launches } = await driveWithRelaunch(true, ["ok"]);
    expect(launches).toEqual([true]);
  });

  it("does not relaunch when it was already visible", async () => {
    const { launches } = await driveWithRelaunch(false, ["ok"]);
    expect(launches).toEqual([false]);
  });
});
