import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deleteStoredPassword, getStoredPassword, getStoredTotpUri, setStoredPassword, setStoredTotpUri } from "../../src/auth/credential-store.js";
import { accountSessionDirectory } from "../../src/utils/config.js";
import { buildConfigToSave } from "../../src/setup/config.js";
import { MemoryCredentialBackend } from "./secure-store-fixtures.js";

const SCHOOL = "https://purdue.brightspace.com";
const SERVICE = "brightspace-mcp-server";
const URI = "otpauth://totp/Purdue?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** The key format every release up to 4.0.0 wrote: the username hashed exactly as given. */
function legacyKey(prefix: "password" | "totp", username: string): string {
  const hash = createHash("sha256").update(JSON.stringify([SCHOOL, username])).digest("hex");
  return JSON.stringify([SERVICE, `${prefix}:${hash}`]);
}

describe("Email usernames identify one account whatever their casing", () => {
  it("finds a password saved under a mixed-case email when asked with the lowercase form", async () => {
    const backend = new MemoryCredentialBackend();
    await setStoredPassword(SCHOOL, "Student@Purdue.edu", "dummy-password", backend);
    expect(await getStoredPassword(SCHOOL, "student@purdue.edu", backend)).toBe("dummy-password");
  });

  it("ignores whitespace around the username", async () => {
    const backend = new MemoryCredentialBackend();
    await setStoredPassword(SCHOOL, "  student@purdue.edu \n", "dummy-password", backend);
    expect(await getStoredPassword(SCHOOL, "student@purdue.edu", backend)).toBe("dummy-password");
  });

  it("finds an authenticator enrollment saved under a mixed-case email when asked with the lowercase form", async () => {
    const backend = new MemoryCredentialBackend();
    await setStoredTotpUri(SCHOOL, "Student@purdue.edu", URI, backend);
    expect(await getStoredTotpUri(SCHOOL, "student@purdue.edu", backend)).toBe(URI);
  });

  it("keeps the case of a plain username, which a school may treat as case-sensitive", async () => {
    const backend = new MemoryCredentialBackend();
    await setStoredPassword(SCHOOL, "Alice", "dummy-password", backend);
    expect(await getStoredPassword(SCHOOL, "alice", backend)).toBeNull();
  });

  it("keeps the same email at two schools apart", async () => {
    const backend = new MemoryCredentialBackend();
    await setStoredPassword(SCHOOL, "student@purdue.edu", "dummy-password", backend);
    expect(await getStoredPassword("https://other.example", "Student@purdue.edu", backend)).toBeNull();
  });

  it("keeps two different emails apart", async () => {
    const backend = new MemoryCredentialBackend();
    await setStoredPassword(SCHOOL, "student@purdue.edu", "dummy-password", backend);
    expect(await getStoredPassword(SCHOOL, "Other@purdue.edu", backend)).toBeNull();
  });
});

describe("Credentials saved by earlier releases stay usable", () => {
  it("still reads a password saved under the exact mixed-case username", async () => {
    const backend = new MemoryCredentialBackend();
    backend.values.set(legacyKey("password", "Student@purdue.edu"), "dummy-password");
    expect(await getStoredPassword(SCHOOL, "Student@purdue.edu", backend)).toBe("dummy-password");
  });

  it("moves a legacy exact-case password to the shared key, so any casing finds it afterwards", async () => {
    const backend = new MemoryCredentialBackend();
    backend.values.set(legacyKey("password", "Student@purdue.edu"), "dummy-password");
    await getStoredPassword(SCHOOL, "Student@purdue.edu", backend);
    expect([...backend.values.keys()]).toEqual([legacyKey("password", "student@purdue.edu")]);
  });

  it("still reads a password saved with surrounding whitespace in the username", async () => {
    const backend = new MemoryCredentialBackend();
    backend.values.set(legacyKey("password", " Student@purdue.edu "), "dummy-password");
    expect(await getStoredPassword(SCHOOL, " Student@purdue.edu ", backend)).toBe("dummy-password");
  });

  it("still returns a legacy password when the store refuses the migration write", async () => {
    const backend = new MemoryCredentialBackend();
    backend.values.set(legacyKey("password", "Student@purdue.edu"), "dummy-password");
    backend.setPassword = async () => { throw new Error("locked"); };
    expect(await getStoredPassword(SCHOOL, "Student@purdue.edu", backend)).toBe("dummy-password");
  });

  it("keeps the legacy password when the store refuses the migration write", async () => {
    const backend = new MemoryCredentialBackend();
    backend.values.set(legacyKey("password", "Student@purdue.edu"), "dummy-password");
    backend.setPassword = async () => { throw new Error("locked"); };
    await getStoredPassword(SCHOOL, "Student@purdue.edu", backend);
    expect(backend.values.get(legacyKey("password", "Student@purdue.edu"))).toBe("dummy-password");
  });

  it("still reads an authenticator enrollment saved under the exact mixed-case username", async () => {
    const backend = new MemoryCredentialBackend();
    backend.values.set(legacyKey("totp", "Student@purdue.edu"), URI);
    expect(await getStoredTotpUri(SCHOOL, "Student@purdue.edu", backend)).toBe(URI);
  });

  it("reads a Purdue-fork enrollment saved under the lowercased email when the username is mixed-case", async () => {
    const backend = new MemoryCredentialBackend();
    backend.values.set(legacyKey("totp", "student@purdue.edu"), URI);
    expect(await getStoredTotpUri(SCHOOL, "Student@purdue.edu", backend)).toBe(URI);
  });

  it("deletes a legacy exact-case password along with the shared one", async () => {
    const backend = new MemoryCredentialBackend();
    backend.values.set(legacyKey("password", "Student@purdue.edu"), "dummy-password");
    await deleteStoredPassword(SCHOOL, "Student@purdue.edu", backend);
    expect(backend.values.size).toBe(0);
  });
});

describe("Session directories follow the same account identity", () => {
  it("gives mixed-case and lowercase forms of an email the same session directory", () => {
    expect(accountSessionDirectory("/root", SCHOOL, " Student@Purdue.edu"))
      .toBe(accountSessionDirectory("/root", SCHOOL, "student@purdue.edu"));
  });

  it("keeps two plain usernames that differ only in case apart", () => {
    expect(accountSessionDirectory("/root", SCHOOL, "Alice"))
      .not.toBe(accountSessionDirectory("/root", SCHOOL, "alice"));
  });

  it("keeps using a session directory an earlier release created under the exact-case username", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "username-casing-"));
    try {
      const hash = createHash("sha256").update(JSON.stringify([SCHOOL, "Student@purdue.edu"])).digest("hex");
      const legacy = path.join(root, "accounts", hash);
      await fs.mkdir(legacy, { recursive: true });
      expect(accountSessionDirectory(root, SCHOOL, "Student@purdue.edu")).toBe(legacy);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Setup saves the canonical username", () => {
  it("saves an email trimmed and lowercased", () => {
    const config = buildConfigToSave(null, { baseUrl: SCHOOL, username: " Student@Purdue.edu ", password: "x", headless: true });
    expect(config.username).toBe("student@purdue.edu");
  });

  it("saves a plain username trimmed with its case kept", () => {
    const config = buildConfigToSave(null, { baseUrl: SCHOOL, username: " Alice ", password: "x", headless: true });
    expect(config.username).toBe("Alice");
  });

  it("keeps the saved spelling when the same email is typed again in another case", () => {
    const existing = { baseUrl: SCHOOL, username: "Student@purdue.edu" };
    const config = buildConfigToSave(existing, { baseUrl: SCHOOL, username: "student@PURDUE.edu ", password: "x", headless: true });
    expect(config.username).toBe("Student@purdue.edu");
  });

  it("lowercases a newly typed email that replaces a different saved account", () => {
    const existing = { baseUrl: SCHOOL, username: "Other@purdue.edu" };
    const config = buildConfigToSave(existing, { baseUrl: SCHOOL, username: "Student@purdue.edu", password: "x", headless: true });
    expect(config.username).toBe("student@purdue.edu");
  });
});
