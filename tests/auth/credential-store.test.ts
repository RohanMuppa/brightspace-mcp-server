import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { assertNativeCredentialStoreAvailable, getSessionEncryptionKey, getStoredPassword, hasSessionEncryptionKey, setStoredPassword, NativeCredentialStoreError, nativeCredentialBackend } from "../../src/auth/credential-store.js";
import { MemoryCredentialBackend } from "./secure-store-fixtures.js";

describe("Credential store", () => {
  it("answers native key presence per directory and never guesses when the store is unreachable", async () => {
    const backend = new MemoryCredentialBackend();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "key-presence-test-"));
    try {
      const mine = path.join(root, "mine");
      const other = path.join(root, "other");
      await fs.mkdir(other, { recursive: true });
      await getSessionEncryptionKey(mine, backend);
      expect(await hasSessionEncryptionKey(mine, backend)).toBe(true);
      expect(await hasSessionEncryptionKey(other, backend)).toBe(false);
      backend.getPassword = async () => { throw new NativeCredentialStoreError(); };
      await expect(hasSessionEncryptionKey(mine, backend)).rejects.toBeInstanceOf(NativeCredentialStoreError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("separates credentials by tenant and username while normalizing URL origins", async () => {
    const backend = new MemoryCredentialBackend();
    await setStoredPassword("https://school.example/", "alice", "dummy-password", backend);
    expect(await getStoredPassword("https://school.example/d2l/home", "alice", backend)).toBe("dummy-password");
    expect(await getStoredPassword("https://other.example/", "alice", backend)).toBeNull();
    expect(await getStoredPassword("https://school.example/", "bob", backend)).toBeNull();
  });

  it("fails verification when the native store does not retain a password", async () => {
    const backend = new MemoryCredentialBackend();
    backend.setPassword = async () => {};
    await expect(setStoredPassword("https://school.example", "alice", "dummy-password", backend)).rejects.toBeInstanceOf(NativeCredentialStoreError);
  });

  it("requires a real Secret Service on Linux", async () => {
    const missing = vi.fn(async () => { throw new Error("service absent"); });
    await expect(assertNativeCredentialStoreAvailable("linux", missing)).rejects.toThrow("Secret Service");
    expect(missing).toHaveBeenCalledOnce();
    const present = vi.fn(async () => {});
    await expect(assertNativeCredentialStoreAvailable("linux", present)).resolves.toBeUndefined();
  });

  it("does not run Linux probes on macOS or Windows", async () => {
    const probe = vi.fn(async () => {});
    await assertNativeCredentialStoreAvailable("darwin", probe);
    await assertNativeCredentialStoreAvailable("win32", probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it.runIf(process.env.BRIGHTSPACE_TEST_NATIVE_KEYRING === "1")("round-trips and removes a temporary native credential entry", async () => {
    const service = `brightspace-mcp-server-test-${randomUUID()}`;
    const account = "dummy-test-account";
    try {
      expect(await nativeCredentialBackend.getPassword(service, account)).toBeNull();
      await nativeCredentialBackend.setPassword(service, account, "dummy-keyring-test-value");
      expect(await nativeCredentialBackend.getPassword(service, account)).toBe("dummy-keyring-test-value");
    } finally {
      await nativeCredentialBackend.deletePassword(service, account);
    }
    expect(await nativeCredentialBackend.getPassword(service, account)).toBeNull();
  }, 30_000);
});
