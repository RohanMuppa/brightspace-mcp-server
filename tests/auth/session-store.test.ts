import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SessionStore } from "../../src/auth/session-store.js";
import { NativeCredentialStoreError } from "../../src/auth/credential-store.js";
import { MemoryCredentialBackend, retireTestFile, testToken, writeLegacySession } from "./secure-store-fixtures.js";

describe("SessionStore", () => {
  let dir: string;
  let backend: MemoryCredentialBackend;
  let store: SessionStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "secure-session-test-"));
    backend = new MemoryCredentialBackend();
    store = new SessionStore(dir, { backend, trash: retireTestFile });
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("persists tokens only as authenticated ciphertext and survives a new store instance", async () => {
    await store.save(testToken);
    expect(await new SessionStore(dir, { backend }).load()).toEqual(testToken);
    const contents = await fs.readFile(path.join(dir, "session.json"), "utf8");
    expect(JSON.parse(contents).version).toBe(2);
    expect(contents).not.toContain(testToken.accessToken);
    expect(contents).not.toContain(testToken.cookieHeader);
    expect(contents).not.toContain(testToken.csrfToken);
    if (process.platform !== "win32") expect((await fs.stat(path.join(dir, "session.json"))).mode & 0o777).toBe(0o600);
    await expect(fs.access(path.join(dir, "salt"))).rejects.toThrow();
  });

  it("returns null only for an absent session", async () => {
    expect(await store.load()).toBeNull();
    expect(backend.writes).toBe(0);
  });

  it("preserves malformed files and reports the failure", async () => {
    const file = path.join(dir, "session.json");
    await fs.writeFile(file, "not-json");
    await expect(store.load()).rejects.toThrow("Existing session data was preserved");
    await expect(store.save(testToken)).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("not-json");
  });

  it("detects ciphertext tampering without removing the saved session", async () => {
    await store.save(testToken);
    const file = path.join(dir, "session.json");
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.encrypted.authTag = "0".repeat(32);
    const tampered = JSON.stringify(record);
    await fs.writeFile(file, tampered);
    await expect(store.load()).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(tampered);
  });

  it("reports a missing key without generating another key or erasing state", async () => {
    await store.save(testToken);
    const file = path.join(dir, "session.json");
    const saved = await fs.readFile(file, "utf8");
    backend.values.clear();
    await expect(store.load()).rejects.toBeInstanceOf(NativeCredentialStoreError);
    await expect(store.save(testToken)).rejects.toBeInstanceOf(NativeCredentialStoreError);
    expect(backend.writes).toBe(1);
    expect(await fs.readFile(file, "utf8")).toBe(saved);
  });

  it("propagates an unavailable native credential store", async () => {
    await store.save(testToken);
    backend.getPassword = async () => { throw new NativeCredentialStoreError(); };
    await expect(store.load()).rejects.toBeInstanceOf(NativeCredentialStoreError);
  });

  it.each(["username", "hostname"])("migrates legacy %s key derivation only after encrypted save succeeds", async (mode) => {
    await writeLegacySession(dir, os.userInfo().username + (mode === "hostname" ? os.hostname() : ""));
    expect(await store.load()).toEqual(testToken);
    expect(JSON.parse(await fs.readFile(path.join(dir, "session.json"), "utf8")).version).toBe(2);
    expect(await new SessionStore(dir, { backend }).load()).toEqual(testToken);
  });

  it("refuses a version 1 session planted after native key storage is in use", async () => {
    await store.save(testToken);
    // Anything able to write the session directory can forge a version 1
    // record: its key is scrypt over the local account name and a salt it
    // writes itself. Only the native key proves the credential store was
    // reachable, so a version 1 file appearing afterwards is a downgrade.
    const planted = await writeLegacySession(dir);
    await expect(store.load()).rejects.toThrow("not trusted");
    await expect(store.saveIfCurrent({ ...testToken, accessToken: "forged" }, testToken)).rejects.toThrow("not trusted");
    expect(await fs.readFile(path.join(dir, "session.json"), "utf8")).toBe(planted);
    expect(backend.writes).toBe(1);
  });

  it("still upgrades a version 1 session in a directory that has no key yet", async () => {
    // A key belonging to another account directory must not be mistaken for
    // this one's completed upgrade.
    await new SessionStore(path.join(dir, "other-account"), { backend }).save(testToken);
    await writeLegacySession(dir);
    expect(await store.load()).toEqual(testToken);
    expect(JSON.parse(await fs.readFile(path.join(dir, "session.json"), "utf8")).version).toBe(2);
  });

  it("preserves legacy ciphertext when native key storage fails", async () => {
    const saved = await writeLegacySession(dir);
    backend.setPassword = async () => { throw new NativeCredentialStoreError(); };
    await expect(store.load()).rejects.toBeInstanceOf(NativeCredentialStoreError);
    expect(await fs.readFile(path.join(dir, "session.json"), "utf8")).toBe(saved);
  });

  it("preserves legacy ciphertext when atomic writing fails", async () => {
    const saved = await writeLegacySession(dir);
    const failing = new SessionStore(dir, { backend, write: async () => { throw new Error("disk full"); } });
    await expect(failing.load()).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, "session.json"), "utf8")).toBe(saved);
  });

  it("clears a readable session recoverably", async () => {
    await store.save(testToken);
    await store.clear();
    expect(await store.load()).toBeNull();
    expect((await fs.readdir(dir)).some((name) => name.startsWith("session.json.retired-"))).toBe(true);
  });

  it("never clears unreadable data", async () => {
    await fs.writeFile(path.join(dir, "session.json"), "{broken");
    await expect(store.clear()).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, "session.json"), "utf8")).toBe("{broken");
  });

  it("keeps a new login when an older mint tries to save or clear", async () => {
    await store.save(testToken);
    const newer = { ...testToken, capturedAt: 200, accessToken: "newer-login" };
    await store.save(newer);
    expect(await store.saveIfCurrent({ ...testToken, accessToken: "stale-mint" }, testToken)).toBe(false);
    expect(await store.clearIfCurrent(testToken)).toBe(false);
    expect(await store.load()).toEqual(newer);
    expect(await store.saveIfCurrent({ ...newer, accessToken: "fresh-mint" }, newer)).toBe(true);
  });

  it("serializes simultaneous compare-and-save updates", async () => {
    await store.save(testToken);
    const other = new SessionStore(dir, { backend, trash: retireTestFile });
    const result = await Promise.all([
      store.saveIfCurrent({ ...testToken, accessToken: "mint-a" }, testToken),
      other.saveIfCurrent({ ...testToken, accessToken: "mint-b" }, testToken),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(["mint-a", "mint-b"]).toContain((await store.load())?.accessToken);
  });
});
