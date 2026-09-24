/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { acquireProcessLock, AuthenticationInProgressError } from "./auth-lock.js";

const SERVICE = "brightspace-mcp-server";
const LINUX_GUIDANCE = "Linux requires secret-tool and an unlocked Secret Service. Install libsecret-tools (Debian/Ubuntu) or your distribution's libsecret tools, unlock the desktop keyring, then retry. Temporary kernel key storage is not supported.";

export interface CredentialBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
}

export class NativeCredentialStoreError extends Error {
  readonly code = "NATIVE_CREDENTIAL_STORE_UNAVAILABLE";

  constructor(message = "The native credential store is locked or unavailable. Unlock your operating system credential store and try again.", cause?: unknown) {
    super(message, { cause });
    this.name = "NativeCredentialStoreError";
  }
}

export interface SecretToolResult { code: number; stdout: string; stderr: string }
export type SecretToolRunner = (args: string[], secret?: string) => Promise<SecretToolResult>;

/** No shell, no secret arguments, and no command diagnostics in surfaced errors. */
async function runSecretTool(args: string[], secret?: string): Promise<SecretToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const fail = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      reject(new NativeCredentialStoreError(LINUX_GUIDANCE));
    };
    const timer = setTimeout(fail, 30_000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) fail();
      else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.end(secret ?? "");
  });
}

/** Use libsecret directly: the native Node binding silently falls back to kernel keys. */
export function createLinuxCredentialBackend(run: SecretToolRunner = runSecretTool): CredentialBackend {
  const attributes = (service: string, account: string) => ["service", service, "username", account];
  const assertAbsent = async (service: string, account: string) => {
    const result = await run(["search", "--all", ...attributes(service, account)]);
    // A cancelled unlock can make lookup return the same exit code as absence.
    // Search without unlocking must also show no matching item before accepting absence.
    if (result.code !== 0 || result.stdout !== "" || result.stderr !== "") throw new NativeCredentialStoreError(LINUX_GUIDANCE);
  };
  return {
    async getPassword(service, account) {
      const result = await run(["lookup", ...attributes(service, account)]);
      if (result.code === 0 && result.stderr === "") {
        // secret-tool adds a newline only for a TTY. Piped output is the exact secret.
        return result.stdout;
      }
      if (result.code === 1 && result.stdout === "" && result.stderr === "") {
        await assertAbsent(service, account);
        return null;
      }
      throw new NativeCredentialStoreError(LINUX_GUIDANCE);
    },
    async setPassword(service, account, password) {
      // secret-tool's stdin reader uses an 8192-byte buffer.
      if (Buffer.byteLength(password, "utf8") >= 8192) throw new NativeCredentialStoreError("The credential exceeds secret-tool's supported size.");
      const result = await run(["store", "--label=Brightspace MCP", "--collection=default", ...attributes(service, account)], password);
      if (result.code !== 0 || result.stderr !== "") throw new NativeCredentialStoreError(LINUX_GUIDANCE);
    },
    async deletePassword(service, account) {
      const result = await run(["clear", ...attributes(service, account)]);
      if ((result.code !== 0 && result.code !== 1) || result.stdout !== "" || result.stderr !== "") throw new NativeCredentialStoreError(LINUX_GUIDANCE);
      await assertAbsent(service, account);
    },
  };
}

const linuxCredentialBackend = createLinuxCredentialBackend();

export async function assertNativeCredentialStoreAvailable(platform = process.platform, probe = async () => {
  await linuxCredentialBackend.getPassword("brightspace-mcp-server-availability-probe", "probe");
}): Promise<void> {
  if (platform !== "linux") return;
  try {
    await probe();
  } catch (error) {
    if (error instanceof NativeCredentialStoreError) throw error;
    throw new NativeCredentialStoreError(LINUX_GUIDANCE);
  }
}

async function nativeEntry(service: string, account: string) {
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(service, account);
  } catch (error) {
    if (error instanceof NativeCredentialStoreError) throw error;
    throw new NativeCredentialStoreError(undefined, error);
  }
}

export const nativeCredentialBackend: CredentialBackend = {
  async getPassword(service, account) {
    try {
      if (process.platform === "linux") return await linuxCredentialBackend.getPassword(service, account);
      return (await (await nativeEntry(service, account)).getPassword()) ?? null;
    } catch (error) {
      if (error instanceof NativeCredentialStoreError) throw error;
      throw new NativeCredentialStoreError(undefined, error);
    }
  },
  async setPassword(service, account, password) {
    try {
      if (process.platform === "linux") return await linuxCredentialBackend.setPassword(service, account, password);
      await (await nativeEntry(service, account)).setPassword(password);
    } catch (error) {
      if (error instanceof NativeCredentialStoreError) throw error;
      throw new NativeCredentialStoreError(undefined, error);
    }
  },
  async deletePassword(service, account) {
    try {
      if (process.platform === "linux") return await linuxCredentialBackend.deletePassword(service, account);
      await (await nativeEntry(service, account)).deletePassword();
    } catch (error) {
      if (error instanceof NativeCredentialStoreError) throw error;
      throw new NativeCredentialStoreError(undefined, error);
    }
  },
};

function passwordAccount(baseUrl: string, username: string): string {
  const identity = JSON.stringify([new URL(baseUrl).origin, username]);
  return `password:${createHash("sha256").update(identity).digest("hex")}`;
}

export async function getStoredPassword(baseUrl: string, username: string, backend: CredentialBackend = nativeCredentialBackend): Promise<string | null> {
  return backend.getPassword(SERVICE, passwordAccount(baseUrl, username));
}

export async function setStoredPassword(baseUrl: string, username: string, password: string, backend: CredentialBackend = nativeCredentialBackend): Promise<void> {
  const account = passwordAccount(baseUrl, username);
  await backend.setPassword(SERVICE, account, password);
  if (await backend.getPassword(SERVICE, account) !== password) {
    throw new NativeCredentialStoreError("The saved password could not be verified in the native credential store. Existing configuration was preserved.");
  }
}

function decodeKey(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new NativeCredentialStoreError("The saved session encryption key is invalid. Restore its native credential store entry before retrying.");
  }
  return Buffer.from(value, "hex");
}

function sessionKeyAccount(canonicalDir: string): string {
  return `session-key:${createHash("sha256").update(canonicalDir).digest("hex")}`;
}

/**
 * Whether this session directory already holds a native encryption key, which
 * is what separates an upgrade that has not run yet from one that finished.
 * A locked or unavailable store raises instead of answering false, so a
 * caller never mistakes "cannot tell" for "not migrated".
 */
export async function hasSessionEncryptionKey(sessionDir: string, backend: CredentialBackend = nativeCredentialBackend): Promise<boolean> {
  const canonicalDir = await fs.realpath(sessionDir);
  return (await backend.getPassword(SERVICE, sessionKeyAccount(canonicalDir))) !== null;
}

/** The canonical session directory stays stable when DHCP changes the hostname. */
export async function getSessionEncryptionKey(sessionDir: string, backend: CredentialBackend = nativeCredentialBackend, create = true): Promise<Buffer> {
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const canonicalDir = await fs.realpath(sessionDir);
  const account = sessionKeyAccount(canonicalDir);
  const existing = await backend.getPassword(SERVICE, account);
  if (existing !== null) {
    try {
      return decodeKey(existing);
    } catch (error) {
      // Another process may still be finishing the first native-store write.
      // Recheck malformed optimistic reads after acquiring the init lock. A
      // persistently invalid value will fail at the guarded read below.
      if (!(error instanceof NativeCredentialStoreError)) throw error;
    }
  }
  if (!create) {
    throw new NativeCredentialStoreError("The session encryption key is missing from the native credential store. Existing encrypted session data was preserved. Restore the native credential store entry before retrying.");
  }
  // Only initialization is serialized. Native secret stores do not provide CAS.
  let release: (() => Promise<void>) | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      release = await acquireProcessLock(path.join(canonicalDir, ".keyring-key-init.lock"));
      break;
    } catch (error) {
      if (!(error instanceof AuthenticationInProgressError) || attempt === 99) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    const current = await backend.getPassword(SERVICE, account);
    if (current !== null) return decodeKey(current);
    // Creating a replacement key would orphan other encrypted files in this directory.
    for (const name of ["storage-state.encrypted.json", "session.json"]) {
      try {
        const contents = await fs.readFile(path.join(canonicalDir, name), "utf8");
        if (name === "storage-state.encrypted.json" || JSON.parse(contents).version === 2) {
          throw new NativeCredentialStoreError("The session encryption key is missing, but encrypted authentication state still exists. Restore the native credential store entry before retrying. Saved data was preserved.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const key = randomBytes(32).toString("hex");
    await backend.setPassword(SERVICE, account, key);
    if (await backend.getPassword(SERVICE, account) !== key) {
      throw new NativeCredentialStoreError("The session encryption key could not be verified in the native credential store. No session data was written.");
    }
    return decodeKey(key);
  } finally {
    await release?.();
  }
}
