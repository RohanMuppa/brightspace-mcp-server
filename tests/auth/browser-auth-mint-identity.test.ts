import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserAuth } from "../../src/auth/browser-auth.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * The cookie-mint path (used when the login harvested a cookie header and a
 * CSRF token) returns only a JWT, with no identity. It must still report
 * signedInAs by reusing the same whoami read the other extraction
 * strategies already validate against, and a failure reading identity must
 * never fail a login that already has a working token.
 */

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), launch: vi.fn(), mint: vi.fn(),
}));
vi.mock("../../src/auth/browser-state-store.js", () => ({
  BrowserStateStore: class { load = mocks.load; save = mocks.save; },
}));
vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));
vi.mock("../../src/auth/token-mint.js", () => ({ mintAccessToken: mocks.mint }));

let directory: string;
let auth: BrowserAuth;
let browser: any;
let context: any;
let page: any;

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-mint-identity-test-"));
  const config = {
    baseUrl: "https://school.example", sessionDir: directory, tokenTtl: 3600,
    headless: true, username: "student", password: "dummy",
    courseFilter: {},
  } as AppConfig;
  page = { on: vi.fn(), removeListener: vi.fn() };
  context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}), storageState: vi.fn(async () => ({ cookies: [], origins: [] })) };
  browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  mocks.launch.mockResolvedValue(browser);
  mocks.load.mockResolvedValue(undefined);
  auth = new BrowserAuth(config);
  vi.spyOn(auth as any, "navigateAndLogin").mockResolvedValue(true);
  vi.spyOn(auth as any, "harvestSessionMaterial").mockResolvedValue({ cookieHeader: "d2lSessionVal=aaa", csrfToken: "xsrf-1" });
});

afterEach(() => { vi.restoreAllMocks(); });

describe("BrowserAuth mint-path identity", () => {
  it("captures uniqueName/displayName when the token comes from the cookie mint", async () => {
    mocks.mint.mockResolvedValue({ ok: true, accessToken: "minted-jwt" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ Identifier: "123", UniqueName: "jdoe", DisplayName: "Jane Doe" }),
      { headers: { "content-type": "application/json" } }
    ));

    const token = await auth.authenticate();

    expect(token.accessToken).toBe("minted-jwt");
    expect(token.uniqueName).toBe("jdoe");
    expect(token.displayName).toBe("Jane Doe");
  });

  it("still returns a usable token when the identity whoami read fails", async () => {
    mocks.mint.mockResolvedValue({ ok: true, accessToken: "minted-jwt" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const token = await auth.authenticate();

    expect(token.accessToken).toBe("minted-jwt");
    expect(token.uniqueName).toBeUndefined();
    expect(token.displayName).toBeUndefined();
  });
});
