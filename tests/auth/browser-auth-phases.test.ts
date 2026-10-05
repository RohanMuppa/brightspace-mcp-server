import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserAuth } from "../../src/auth/browser-auth.js";
import type { OnMfaChallenge } from "../../src/auth/sso-flow.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * A slow first sign-in can't be diagnosed from its total time alone, so the
 * automatic child reports how long each browser stage took (issue #182).
 * Every stage that ran is reported, in order, and the MFA challenge splits
 * the identity provider's login into typing credentials and waiting on the
 * phone.
 */

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), launch: vi.fn(), mint: vi.fn(), login: vi.fn(),
  announce: undefined as OnMfaChallenge | undefined,
}));
vi.mock("../../src/auth/browser-state-store.js", () => ({
  BrowserStateStore: class { load = mocks.load; save = mocks.save; },
}));
vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));
vi.mock("../../src/auth/token-mint.js", () => ({ mintAccessToken: mocks.mint }));
vi.mock("../../src/auth/sso-flow.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/auth/sso-flow.js")>(),
  createSSOFlow: (_config: unknown, _code: unknown, onMfaChallenge?: OnMfaChallenge) => {
    mocks.announce = onMfaChallenge;
    return { hasCredentials: () => true, login: mocks.login };
  },
}));

const BASE_URL = "https://school.example";
let directory: string;
let phases: Array<[string, number]>;
let page: any;

function newAuth(): BrowserAuth {
  const config = {
    baseUrl: BASE_URL, sessionDir: directory, tokenTtl: 3600,
    headless: true, username: "student", password: "dummy", courseFilter: {},
  } as AppConfig;
  return new BrowserAuth(config, {
    onMfaChallenge: () => {},
    onPhase: (phase, elapsedMs) => phases.push([phase, elapsedMs]),
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  phases = [];
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-phases-test-"));
  page = { on: vi.fn(), removeListener: vi.fn() };
  const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}), storageState: vi.fn(async () => ({ cookies: [], origins: [] })) };
  mocks.launch.mockImplementation(async () => {
    vi.advanceTimersByTime(2000);
    return { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  });
  mocks.load.mockResolvedValue(undefined);
  mocks.mint.mockImplementation(async () => {
    vi.advanceTimersByTime(700);
    return { ok: true, accessToken: "minted-jwt" };
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("BrowserAuth phase timings", () => {
  it("reports browser launch and token acquisition around a restored session", async () => {
    const auth = newAuth();
    vi.spyOn(auth as any, "navigateAndLogin").mockResolvedValue(true);
    vi.spyOn(auth as any, "harvestSessionMaterial").mockResolvedValue({ cookieHeader: "d2lSessionVal=aaa", csrfToken: "xsrf-1" });

    await auth.authenticate();

    expect(phases).toEqual([["launch", 2000], ["token", 700]]);
  });

  it("splits a login at the MFA challenge into credentials and approval wait", async () => {
    const auth = newAuth();
    page.goto = vi.fn(async () => { vi.advanceTimersByTime(3000); return null; });
    vi.spyOn(auth as any, "awaitSilentSSO").mockImplementation(async () => { vi.advanceTimersByTime(4000); return false; });
    vi.spyOn(auth as any, "hasMfaChallenge").mockResolvedValue(false);
    vi.spyOn(auth as any, "hasCredentialPrompt").mockResolvedValue(true);
    vi.spyOn(auth as any, "hasLiveSession").mockResolvedValue(true);
    mocks.login.mockImplementation(async () => {
      vi.advanceTimersByTime(5000);
      mocks.announce?.("47");
      vi.advanceTimersByTime(20000);
      mocks.announce?.("12");
      vi.advanceTimersByTime(1000);
      return true;
    });

    await (auth as any).navigateAndLogin(page);

    expect(phases).toEqual([["navigation", 3000], ["silentSso", 4000], ["credentials", 5000], ["approvalWait", 21000]]);
  });

  it("reports a login with no MFA challenge as credentials only", async () => {
    const auth = newAuth();
    page.goto = vi.fn(async () => null);
    vi.spyOn(auth as any, "awaitSilentSSO").mockResolvedValue(false);
    vi.spyOn(auth as any, "hasMfaChallenge").mockResolvedValue(false);
    vi.spyOn(auth as any, "hasCredentialPrompt").mockResolvedValue(true);
    vi.spyOn(auth as any, "hasLiveSession").mockResolvedValue(true);
    mocks.login.mockImplementation(async () => { vi.advanceTimersByTime(6000); return true; });

    await (auth as any).navigateAndLogin(page);

    expect(phases.filter(([phase]) => phase === "credentials" || phase === "approvalWait")).toEqual([["credentials", 6000]]);
  });

  it("still reports the stage that failed", async () => {
    const auth = newAuth();
    page.goto = vi.fn(async () => { vi.advanceTimersByTime(60000); throw new Error("net::ERR_NAME_NOT_RESOLVED"); });

    await expect((auth as any).navigateAndLogin(page)).rejects.toThrow();

    expect(phases).toEqual([["navigation", 60000]]);
  });
});
