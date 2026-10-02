import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BrowserAuth } from "../../src/auth/browser-auth.js";
import { BrowserStateStore, type BrowserState } from "../../src/auth/browser-state-store.js";
import { nativeCredentialBackend } from "../../src/auth/credential-store.js";
import { readMicrosoftSession } from "../../src/auth/microsoft-session.js";
import { MfaApprovalError } from "../../src/auth/sso-flow.js";
import type { AppConfig } from "../../src/types/index.js";
import { MemoryCredentialBackend } from "./secure-store-fixtures.js";

/**
 * A sign-in that fails after Entra already refreshed its cookies must not
 * throw those cookies away, and one that refreshed nothing must leave the
 * saved jar exactly as it was.
 */

const launch = vi.hoisted(() => vi.fn());
vi.mock("playwright", () => ({ chromium: { launch } }));

const IN_90_DAYS = Date.parse("2026-12-30T12:00:00Z") / 1000;

function entraCookie(name: string, expires: number) {
  return { name, value: `${name}-value`, domain: ".login.microsoftonline.com", path: "/", expires, httpOnly: true, secure: true, sameSite: "None" as const };
}

const previous: BrowserState = { cookies: [entraCookie("ESTSAUTHPERSISTENT", 1_000)], origins: [] };
const refreshed: BrowserState = { cookies: [entraCookie("ESTSAUTHPERSISTENT", IN_90_DAYS)], origins: [] };

let dir: string;
let current: BrowserState;
let auth: BrowserAuth;
const stateFile = () => path.join(dir, "storage-state.encrypted.json");

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "keep-entra-state-test-"));
  const backend = new MemoryCredentialBackend();
  vi.spyOn(nativeCredentialBackend, "getPassword").mockImplementation(backend.getPassword.bind(backend));
  vi.spyOn(nativeCredentialBackend, "setPassword").mockImplementation(backend.setPassword.bind(backend));
  vi.spyOn(nativeCredentialBackend, "deletePassword").mockImplementation(backend.deletePassword.bind(backend));
  await new BrowserStateStore(dir).save(previous);

  const page = { on: vi.fn(), removeListener: vi.fn() };
  const context = { newPage: async () => page, close: async () => {}, storageState: async () => current };
  launch.mockResolvedValue({ newContext: async () => context, close: async () => {} });
  auth = new BrowserAuth({
    baseUrl: "https://purdue.brightspace.com", sessionDir: dir, tokenTtl: 3600,
    headless: true, username: "student", password: "dummy", courseFilter: { activeOnly: true },
  } as AppConfig);
  (auth as any).ssoFlow.rememberMfaResult = () => ({ outcome: "ticked", at: "2026-10-01T11:59:00.000Z" });
  vi.spyOn(auth as any, "navigateAndLogin").mockRejectedValue(new MfaApprovalError());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("browser state on a failed sign-in", () => {
  it("still fails with the original error after keeping newer Entra cookies", async () => {
    current = refreshed;
    await expect(auth.authenticate()).rejects.toBeInstanceOf(MfaApprovalError);
  });

  it("keeps newer Entra cookies", async () => {
    current = refreshed;
    await auth.authenticate().catch(() => {});
    expect(await new BrowserStateStore(dir).load()).toEqual(refreshed);
  });

  it("records what Microsoft remembered alongside the kept cookies", async () => {
    current = refreshed;
    await auth.authenticate().catch(() => {});
    expect(await readMicrosoftSession(dir, Date.parse("2026-10-01T12:00:00Z"))).toEqual({
      staySignedIn: true,
      staySignedInExpires: "2026-12-30T12:00:00.000Z",
      rememberMfa: "ticked",
      rememberMfaAt: "2026-10-01T11:59:00.000Z",
    });
  });

  it("leaves the saved state byte-identical when Entra refreshed nothing", async () => {
    current = { cookies: [entraCookie("ESTSAUTHPERSISTENT", 1_000)], origins: [] };
    const before = await fs.readFile(stateFile());
    await auth.authenticate().catch(() => {});
    expect((await fs.readFile(stateFile())).equals(before)).toBe(true);
  });

  it("leaves the saved state byte-identical when the browser jar has no Entra cookies", async () => {
    current = { cookies: [], origins: [] };
    const before = await fs.readFile(stateFile());
    await auth.authenticate().catch(() => {});
    expect((await fs.readFile(stateFile())).equals(before)).toBe(true);
  });
});
