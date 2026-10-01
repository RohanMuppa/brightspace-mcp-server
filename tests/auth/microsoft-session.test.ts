import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasNewerEntraState, readMicrosoftSession, recordMicrosoftSession } from "../../src/auth/microsoft-session.js";
import type { BrowserState } from "../../src/auth/browser-state-store.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const IN_90_DAYS = NOW / 1000 + 90 * 24 * 60 * 60;

function cookie(name: string, expires: number, domain = ".login.microsoftonline.com", value = "secret-cookie-value") {
  return { name, value, domain, path: "/", expires, httpOnly: true, secure: true, sameSite: "None" as const };
}

function state(...cookies: ReturnType<typeof cookie>[]): BrowserState {
  return { cookies, origins: [] };
}

describe("hasNewerEntraState", () => {
  it("is true when Entra's persistent cookie now expires later", () => {
    expect(hasNewerEntraState(state(cookie("ESTSAUTHPERSISTENT", 100)), state(cookie("ESTSAUTHPERSISTENT", 200)))).toBe(true);
  });

  it("is true when an Entra cookie appears that the saved state lacked", () => {
    expect(hasNewerEntraState(state(), state(cookie("ESTSAUTH", -1)))).toBe(true);
  });

  it("is true for a first run with no saved state at all", () => {
    expect(hasNewerEntraState(undefined, state(cookie("ESTSAUTHLIGHT", -1)))).toBe(true);
  });

  it("is false when the Entra cookies are unchanged", () => {
    const same = state(cookie("ESTSAUTHPERSISTENT", 200), cookie("ESTSAUTH", -1));
    expect(hasNewerEntraState(same, same)).toBe(false);
  });

  it("is false when Entra's cookie now expires sooner", () => {
    expect(hasNewerEntraState(state(cookie("ESTSAUTHPERSISTENT", 200)), state(cookie("ESTSAUTHPERSISTENT", 100)))).toBe(false);
  });

  it("is false when the current jar has no Entra cookies", () => {
    expect(hasNewerEntraState(state(cookie("ESTSAUTHPERSISTENT", 200)), state())).toBe(false);
  });

  it("ignores a same-named cookie from another host", () => {
    expect(hasNewerEntraState(state(), state(cookie("ESTSAUTHPERSISTENT", 200, "login.example.com")))).toBe(false);
  });
});

describe("Microsoft session summary", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "microsoft-session-test-"));
    await fs.writeFile(path.join(dir, "storage-state.encrypted.json"), "{}");
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("reports stay-signed-in from Entra's persistent cookie", async () => {
    await recordMicrosoftSession(dir, state(cookie("ESTSAUTHPERSISTENT", IN_90_DAYS)));
    expect(await readMicrosoftSession(dir, NOW)).toMatchObject({
      staySignedIn: true,
      staySignedInExpires: "2026-12-30T12:00:00.000Z",
    });
  });

  it("reports no stay-signed-in without Entra's persistent cookie", async () => {
    await recordMicrosoftSession(dir, state(cookie("ESTSAUTH", -1)));
    expect(await readMicrosoftSession(dir, NOW)).toMatchObject({ staySignedIn: false, staySignedInExpires: null });
  });

  it("reports no stay-signed-in once the persistent cookie has expired", async () => {
    await recordMicrosoftSession(dir, state(cookie("ESTSAUTHPERSISTENT", NOW / 1000 - 60)));
    expect((await readMicrosoftSession(dir, NOW))?.staySignedIn).toBe(false);
  });

  it("reports the remember-MFA outcome recorded with the state", async () => {
    await recordMicrosoftSession(dir, state(), { outcome: "ticked", at: "2026-10-01T11:59:00.000Z" });
    expect(await readMicrosoftSession(dir, NOW)).toMatchObject({ rememberMfa: "ticked", rememberMfaAt: "2026-10-01T11:59:00.000Z" });
  });

  it("keeps the last remember-MFA outcome when a later sign-in never reached the MFA page", async () => {
    await recordMicrosoftSession(dir, state(), { outcome: "ticked", at: "2026-10-01T11:59:00.000Z" });
    await recordMicrosoftSession(dir, state(cookie("ESTSAUTHPERSISTENT", IN_90_DAYS)));
    expect(await readMicrosoftSession(dir, NOW)).toMatchObject({ staySignedIn: true, rememberMfa: "ticked", rememberMfaAt: "2026-10-01T11:59:00.000Z" });
  });

  it("reports remember-MFA as unknown before any MFA page was seen", async () => {
    await recordMicrosoftSession(dir, state());
    expect(await readMicrosoftSession(dir, NOW)).toMatchObject({ rememberMfa: "unknown", rememberMfaAt: null });
  });

  it("round-trips the \"off\" outcome a non-opted-in sign-in records", async () => {
    await recordMicrosoftSession(dir, state(), { outcome: "off", at: "2026-10-01T11:59:00.000Z" });
    expect(await readMicrosoftSession(dir, NOW)).toMatchObject({ rememberMfa: "off", rememberMfaAt: "2026-10-01T11:59:00.000Z" });
  });

  it("is absent when no browser state is saved", async () => {
    await recordMicrosoftSession(dir, state(cookie("ESTSAUTHPERSISTENT", IN_90_DAYS)));
    await fs.rm(path.join(dir, "storage-state.encrypted.json"));
    expect(await readMicrosoftSession(dir, NOW)).toBeUndefined();
  });

  it("is absent before any summary was recorded", async () => {
    expect(await readMicrosoftSession(dir, NOW)).toBeUndefined();
  });

  it("never writes a cookie value to disk", async () => {
    await recordMicrosoftSession(dir, state(cookie("ESTSAUTHPERSISTENT", IN_90_DAYS)));
    const files = await fs.readdir(dir);
    const contents = await Promise.all(files.map(file => fs.readFile(path.join(dir, file), "utf8")));
    expect(contents.join("\n")).not.toContain("secret-cookie-value");
  });
});
