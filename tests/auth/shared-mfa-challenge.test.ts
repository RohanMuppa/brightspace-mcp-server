import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserAuth } from "../../src/auth/browser-auth.js";
import { acquireProcessLock } from "../../src/auth/auth-lock.js";
import type { OnMfaChallenge } from "../../src/auth/sso-flow.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Issue #199: several server processes can share one session store, and only
 * one of them can hold the sign-in lock. A sign-in that loses the race used to
 * answer "already in progress" with nothing the user could act on, while the
 * number to enter sat in another process's tool response. The lock owner now
 * publishes its challenge, and a contender hands it back with the error.
 */

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), launch: vi.fn(), mint: vi.fn(),
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
    return { hasCredentials: () => true, login: vi.fn() };
  },
}));

let directory: string;

function newAuth(): BrowserAuth {
  const config = {
    baseUrl: "https://school.example", sessionDir: directory, tokenTtl: 3600,
    headless: true, username: "student", password: "dummy", courseFilter: {},
  } as AppConfig;
  return new BrowserAuth(config, { onMfaChallenge: () => {} });
}

/** A sign-in that shows `number` (null: a challenge without one) and waits until `approve` is called. */
async function ownerAtChallenge(number: string | null): Promise<{ approve: () => void; finished: Promise<unknown> }> {
  const auth = newAuth();
  let approve!: () => void;
  let challenged!: () => void;
  const approved = new Promise<void>((resolve) => { approve = resolve; });
  const atChallenge = new Promise<void>((resolve) => { challenged = resolve; });
  vi.spyOn(auth as any, "navigateAndLogin").mockImplementation(async () => {
    mocks.announce?.(number);
    challenged();
    await approved;
    return true;
  });
  vi.spyOn(auth as any, "harvestSessionMaterial").mockResolvedValue({ cookieHeader: "d2lSessionVal=aaa", csrfToken: "xsrf-1" });
  const finished = auth.authenticate({ automatic: true });
  await atChallenge;
  return { approve, finished };
}

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-shared-challenge-test-"));
  const page = { on: vi.fn(), removeListener: vi.fn() };
  const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}), storageState: vi.fn(async () => ({ cookies: [], origins: [] })) };
  mocks.launch.mockResolvedValue({ newContext: vi.fn(async () => context), close: vi.fn(async () => {}) });
  mocks.load.mockResolvedValue(undefined);
  mocks.mint.mockResolvedValue({ ok: true, accessToken: "minted-jwt" });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("a sign-in that finds another sign-in holding the lock", () => {
  it("is told the number the lock owner is showing", async () => {
    const owner = await ownerAtChallenge("90");

    await vi.waitFor(() => expect(newAuth().authenticate({ automatic: true }))
      .rejects.toMatchObject({ code: "AUTH_IN_PROGRESS", challenge: { numberMatch: "90" } }));

    owner.approve();
    await owner.finished;
  });

  it("is told a challenge is pending when the owner's shows no number", async () => {
    const owner = await ownerAtChallenge(null);

    await vi.waitFor(async () => {
      const error = await newAuth().authenticate({ automatic: true }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "AUTH_IN_PROGRESS" });
      expect((error as { challenge?: unknown }).challenge).toEqual({});
    });

    owner.approve();
    await owner.finished;
  });

  it("is told no challenge while the owner has not reached MFA", async () => {
    const release = await acquireProcessLock(path.join(directory, ".auth.lock"));

    await expect(newAuth().authenticate({ automatic: true }))
      .rejects.toMatchObject({ code: "AUTH_IN_PROGRESS", challenge: undefined });

    await release();
  });
});

it("leaves no lock behind once a sign-in that published a challenge finishes", async () => {
  const owner = await ownerAtChallenge("90");
  await vi.waitFor(() => expect(newAuth().authenticate({ automatic: true }))
    .rejects.toMatchObject({ challenge: { numberMatch: "90" } }));

  owner.approve();
  await owner.finished;

  await expect(fs.access(path.join(directory, ".auth.lock"))).rejects.toMatchObject({ code: "ENOENT" });
});
