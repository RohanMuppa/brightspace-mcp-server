import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AuthCooldown, AuthenticationCooldownError, MFA_COOLDOWN_MS } from "../../src/auth/auth-cooldown.js";

let sessionDir: string;
let statusFile: string;

beforeEach(async () => {
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "brightspace-cooldown-test-"));
  statusFile = path.join(sessionDir, "auth-status.json");
});

afterEach(async () => {
  await fs.rm(sessionDir, { recursive: true, force: true });
});

describe("automatic MFA cooldown", () => {
  it("allows sign-in when no attempt has been recorded", async () => {
    await expect(new AuthCooldown(sessionDir).assertAllowed()).resolves.toBeUndefined();
  });

  it("pauses automatic sign-in for five minutes after a missed prompt", async () => {
    const cooldown = new AuthCooldown(sessionDir);
    const before = Date.now();
    await cooldown.recordMfaFailure();

    await expect(cooldown.assertAllowed()).rejects.toBeInstanceOf(AuthenticationCooldownError);
    const { retryAt } = JSON.parse(await fs.readFile(statusFile, "utf8"));
    expect(retryAt).toBeGreaterThanOrEqual(before + MFA_COOLDOWN_MS);
  });

  it("releases the pause once the retry time has passed", async () => {
    await fs.writeFile(statusFile, JSON.stringify({ retryAt: Date.now() - 1 }));
    await expect(new AuthCooldown(sessionDir).assertAllowed()).resolves.toBeUndefined();
  });

  it("clears the pause after a successful sign-in", async () => {
    const cooldown = new AuthCooldown(sessionDir);
    await cooldown.recordMfaFailure();
    await cooldown.clear();
    await expect(cooldown.assertAllowed()).resolves.toBeUndefined();
  });

  // A truncated, empty, or non-object status file used to throw straight out of
  // assertAllowed. That runs before the sign-in attempt, and the automatic path
  // only ever clears the file after a sign-in that then never happens, so one
  // damaged non-secret file disabled background sign-in permanently.
  it.each([
    ["a truncated write", '{"retryAt":123'],
    ["an empty file", ""],
    ["a JSON null", "null"],
    ["a JSON array", "[]"],
    ["a non-numeric retryAt", '{"retryAt":"soon"}'],
  ])("does not brick automatic sign-in on %s", async (_name, content) => {
    await fs.writeFile(statusFile, content);
    await expect(new AuthCooldown(sessionDir).assertAllowed()).resolves.toBeUndefined();
  });

  it("discards unusable retry metadata so it cannot be read again", async () => {
    await fs.writeFile(statusFile, '{"retryAt":123');
    await new AuthCooldown(sessionDir).assertAllowed();
    await expect(fs.readFile(statusFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still reports a real pause that survives a reload", async () => {
    await new AuthCooldown(sessionDir).recordMfaFailure();
    await expect(new AuthCooldown(sessionDir).assertAllowed()).rejects.toMatchObject({ code: "AUTH_COOLDOWN" });
  });
});
