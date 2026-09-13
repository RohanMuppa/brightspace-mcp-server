import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserAuth, BrowserAuthTransportError } from "../../src/auth/browser-auth.js";
import { acquireProcessLock, AuthenticationInProgressError } from "../../src/auth/auth-lock.js";
import { AuthCooldown, AuthenticationCooldownError } from "../../src/auth/auth-cooldown.js";
import { MfaApprovalError, UnsupportedAuthenticationError } from "../../src/auth/sso-flow.js";
import type { AppConfig } from "../../src/types/index.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), launch: vi.fn(),
}));
vi.mock("../../src/auth/browser-state-store.js", () => ({
  BrowserStateStore: class { load = mocks.load; save = mocks.save; },
}));
vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));

let directory: string;
let auth: BrowserAuth;
let browser: any;
let context: any;
let page: any;
const token = { accessToken: "test-token", capturedAt: 1, expiresAt: 2, source: "browser" as const, tenantOrigin: "https://school.example" };

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-headless-test-"));
  const config = {
    baseUrl: "https://school.example", sessionDir: directory, tokenTtl: 3600,
    headless: false, username: "student", password: "dummy",
    courseFilter: {},
  } as AppConfig;
  page = { on: vi.fn(), removeListener: vi.fn() };
  context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}), storageState: vi.fn(async () => ({ cookies: [], origins: [] })) };
  browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  mocks.launch.mockResolvedValue(browser);
  mocks.load.mockResolvedValue({ cookies: [{ name: "session", expires: -1 }], origins: [] });
  auth = new BrowserAuth(config);
  vi.spyOn(auth as any, "navigateAndLogin").mockResolvedValue(true);
  vi.spyOn(auth as any, "harvestSessionMaterial").mockResolvedValue({});
  vi.spyOn(auth as any, "tryExtractToken").mockResolvedValue(token);
});

afterEach(() => { vi.restoreAllMocks(); });

describe("BrowserAuth lifecycle", () => {
  it("honors the configured browser visibility and restores state without checking its age", async () => {
    const onAuthenticated = vi.fn(async () => {});
    await expect(auth.authenticate({ onAuthenticated })).resolves.toEqual(token);
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: false, timeout: 60000 }));
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: await mocks.load.mock.results[0].value }));
    expect(context.storageState).toHaveBeenCalledWith();
    expect(mocks.save).toHaveBeenCalledWith({ cookies: [], origins: [] });
    expect(onAuthenticated).toHaveBeenCalledWith(token);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(await fs.readdir(directory)).not.toContain("browser-data");
  });

  it("holds the process lock until token persistence finishes", async () => {
    await auth.authenticate({ onAuthenticated: async () => {
      await expect(acquireProcessLock(path.join(directory, ".auth.lock"))).rejects.toBeInstanceOf(AuthenticationInProgressError);
    } });
    const release = await acquireProcessLock(path.join(directory, ".auth.lock"));
    await release();
  });

  it("releases the lock when persistence fails", async () => {
    await expect(auth.authenticate({ onAuthenticated: async () => { throw new Error("save failed"); } })).rejects.toThrow("save failed");
    const release = await acquireProcessLock(path.join(directory, ".auth.lock"));
    await release();
  });

  it("does not quarantine profiles or retry a generic launch error", async () => {
    const profile = path.join(directory, "browser-data");
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, "sentinel"), "preserve");
    mocks.launch.mockRejectedValue(new Error("Target page, context or browser has been closed"));
    await expect(auth.authenticate()).rejects.toThrow("Target page");
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(profile, "sentinel"), "utf8")).toBe("preserve");
  });

  it("cleans browser resources and signal listeners after successful and failed attempts", async () => {
    const intCount = process.listenerCount("SIGINT");
    const termCount = process.listenerCount("SIGTERM");
    await auth.authenticate();
    expect(process.listenerCount("SIGINT")).toBe(intCount);
    expect(process.listenerCount("SIGTERM")).toBe(termCount);
    (auth as any).tryExtractToken.mockRejectedValue(new Error("token failure"));
    await expect(auth.authenticate()).rejects.toThrow("token failure");
    expect(process.listenerCount("SIGINT")).toBe(intCount);
    expect(process.listenerCount("SIGTERM")).toBe(termCount);
    expect(browser.close).toHaveBeenCalledTimes(2);
  });

  it("persists renewed browser state before token extraction can fail", async () => {
    (auth as any).tryExtractToken.mockResolvedValue(null);
    await expect(auth.authenticate()).rejects.toThrow("Saved SSO cookies have been preserved");
    expect(mocks.save).toHaveBeenCalledWith({ cookies: [], origins: [] });
    expect((auth as any).navigateAndLogin).toHaveBeenCalledOnce();
  });
});

describe("headless credential login and cooldown", () => {
  beforeEach(() => {
    (auth as any).navigateAndLogin.mockRestore();
    page.goto = vi.fn(async () => null);
    page.locator = vi.fn((selector: string) => ({ first: () => ({ isVisible: async () => selector === "input[type=email]" }) }));
    (auth as any).ssoFlow = { hasCredentials: () => true, login: vi.fn(async () => true) };
    vi.spyOn(auth as any, "awaitSilentSSO").mockResolvedValue(false);
    vi.spyOn(auth as any, "hasLiveSession").mockResolvedValue(true);
  });

  it("records cooldown only after an actual failed MFA challenge", async () => {
    (auth as any).ssoFlow.login.mockRejectedValue(new MfaApprovalError());
    await expect(auth.authenticate()).rejects.toBeInstanceOf(MfaApprovalError);
    await expect(new AuthCooldown(directory).assertAllowed()).rejects.toBeInstanceOf(AuthenticationCooldownError);
  });

  it("does not record cooldown for unsupported forms or network errors", async () => {
    (auth as any).ssoFlow.login.mockRejectedValue(new UnsupportedAuthenticationError("unsupported"));
    await expect(auth.authenticate()).rejects.toThrow("unsupported");
    await expect(new AuthCooldown(directory).assertAllowed()).resolves.toBeUndefined();
    page.goto.mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED"));
    await expect(auth.authenticate()).rejects.toBeInstanceOf(BrowserAuthTransportError);
    expect((auth as any).ssoFlow.login).toHaveBeenCalledOnce();
  });

  it("blocks every automatic browser attempt during cooldown before loading or launching", async () => {
    await new AuthCooldown(directory).recordMfaFailure();
    await expect(auth.authenticate({ automatic: true })).rejects.toBeInstanceOf(AuthenticationCooldownError);
    expect((auth as any).ssoFlow.login).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
    (auth as any).awaitSilentSSO.mockResolvedValue(true);
    await expect(auth.authenticate({ automatic: true })).rejects.toBeInstanceOf(AuthenticationCooldownError);
    expect((auth as any).awaitSilentSSO).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("allows explicit authentication immediately during cooldown", async () => {
    await new AuthCooldown(directory).recordMfaFailure();
    await expect(auth.authenticate()).resolves.toEqual(token);
    expect((auth as any).ssoFlow.login).toHaveBeenCalledOnce();
    await expect(new AuthCooldown(directory).assertAllowed()).resolves.toBeUndefined();
  });

  it("rejects incomplete saved credentials without waiting for manual input", async () => {
    (auth as any).ssoFlow.hasCredentials = () => false;
    await expect(auth.authenticate()).rejects.toBeInstanceOf(UnsupportedAuthenticationError);
    expect((auth as any).ssoFlow.login).not.toHaveBeenCalled();
  });

  it("can approve an existing Microsoft MFA challenge without retyping credentials", async () => {
    (auth as any).ssoFlow.hasCredentials = () => false;
    page.locator = vi.fn(() => ({ first: () => ({ isVisible: async () => true }) }));
    await expect(auth.authenticate()).resolves.toEqual(token);
    expect((auth as any).ssoFlow.login).toHaveBeenCalledOnce();
  });

  it("does not attempt login when Brightspace returns a server outage", async () => {
    page.goto.mockResolvedValue({ status: () => 503 });
    await expect(auth.authenticate()).rejects.toBeInstanceOf(BrowserAuthTransportError);
    expect((auth as any).ssoFlow.login).not.toHaveBeenCalled();
  });
});

describe("browser token extraction checks", () => {
  it("waits briefly for D2L to initialize its XSRF helper", async () => {
    page.url = () => "https://school.example/d2l/home";
    page.evaluate = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce("xsrf-ready");
    page.waitForTimeout = vi.fn(async () => {});
    await expect((auth as any).extractXsrfOnly(page)).resolves.toBe("xsrf-ready");
    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(2);
  });

  it("retries after a redirect destroys one XSRF JavaScript context", async () => {
    page.url = () => "https://school.example/d2l/home";
    page.evaluate = vi.fn().mockRejectedValueOnce(new Error("Execution context destroyed")).mockResolvedValueOnce("xsrf-after-redirect");
    page.waitForTimeout = vi.fn(async () => {});
    await expect((auth as any).extractXsrfOnly(page)).resolves.toBe("xsrf-after-redirect");
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  it("requires a user identifier in successful whoami JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sessionExpired: true }), { headers: { "content-type": "application/json" } }));
    await expect((auth as any).validateToken("dummy")).resolves.toBe(false);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ Identifier: "123" }), { headers: { "content-type": "application/json" } }));
    await expect((auth as any).validateToken("dummy")).resolves.toBe(true);
  });

  it("preserves transport errors from token validation", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect((auth as any).validateToken("dummy")).rejects.toBeInstanceOf(BrowserAuthTransportError);
  });
});
