/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { TokenData, SessionFile } from "../types/index.js";
import { SessionStoreError } from "../utils/errors.js";
import { acquireProcessLock, AuthenticationInProgressError } from "./auth-lock.js";
import { hasSessionEncryptionKey, NativeCredentialStoreError } from "./credential-store.js";
import { decrypt, readEncryptedRecord, saveEncryptedRecord, trashFile, type EncryptedRecord, type SecureStoreOptions } from "./encrypted-store.js";

const DEFAULT_SESSION_DIR = path.join(os.homedir(), ".d2l-session");

function validTenantOrigin(origin: unknown): boolean {
  if (origin === undefined) return true;
  if (typeof origin !== "string") return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && parsed.origin === origin;
  } catch {
    return false;
  }
}

function validToken(value: unknown): value is TokenData {
  const token = value as TokenData | null;
  return !!token && typeof token.accessToken === "string" && Number.isFinite(token.capturedAt) && Number.isFinite(token.expiresAt)
    && (token.source === "browser" || token.source === "cache")
    && (token.cookieHeader === undefined || typeof token.cookieHeader === "string")
    && (token.csrfToken === undefined || typeof token.csrfToken === "string")
    && validTenantOrigin(token.tenantOrigin);
}

function equalToken(a: TokenData | null, b: TokenData | null): boolean {
  return a === b || (!!a && !!b && a.accessToken === b.accessToken && a.capturedAt === b.capturedAt
    && a.expiresAt === b.expiresAt && a.source === b.source && a.cookieHeader === b.cookieHeader && a.csrfToken === b.csrfToken && a.tenantOrigin === b.tenantOrigin);
}

/** AES-GCM session persistence with a random key held by the native secret store. */
export class SessionStore {
  private readonly sessionDir: string;
  private readonly sessionFilePath: string;

  constructor(sessionDir = DEFAULT_SESSION_DIR, private readonly options: SecureStoreOptions = {}) {
    this.sessionDir = sessionDir;
    this.sessionFilePath = path.join(sessionDir, "session.json");
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    let release: (() => Promise<void>) | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        release = await acquireProcessLock(path.join(this.sessionDir, ".session-write.lock"));
        break;
      } catch (error) {
        if (!(error instanceof AuthenticationInProgressError) || attempt === 99) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await release?.();
    }
  }

  private async readFile(): Promise<EncryptedRecord | SessionFile | null> {
    try {
      return JSON.parse(await fs.readFile(this.sessionFilePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async decode(record: EncryptedRecord | SessionFile): Promise<TokenData> {
    let token: unknown;
    if (record.version === 2) {
      token = await readEncryptedRecord(this.sessionDir, record, "session", this.options);
    } else if (record.version === 1) {
      // Never generate a salt when loading old data. That would make recovery harder.
      const salt = await fs.readFile(path.join(this.sessionDir, "salt"));
      const username = os.userInfo().username;
      let lastError: unknown;
      for (const material of [username, username + os.hostname()]) {
        try {
          token = JSON.parse(decrypt(record.encrypted, crypto.scryptSync(material, salt, 32)));
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!token) throw lastError;
    } else {
      throw new Error("Unsupported saved session version.");
    }
    if (!validToken(token)) throw new Error("Invalid saved session contents.");
    return token;
  }

  /**
   * A version 1 record is sealed with scrypt over the local account name and
   * an on-disk salt: material every local process already has, so the record
   * proves nothing about who wrote it. It is worth trusting only during the
   * one-time upgrade, which by definition happens before this directory owns
   * a native key. Once the key exists the upgrade has already run, and a
   * version 1 file can only have been planted by something that could write
   * the session directory but could not reach the credential store. Refuse it
   * rather than let it replace the authenticated session.
   */
  private async assertLegacyUpgradePending(): Promise<void> {
    if (!await hasSessionEncryptionKey(this.sessionDir, this.options.backend)) return;
    throw new SessionStoreError("An old unauthenticated session file appeared after this installation was already using native key storage. It was not trusted and was left in place. Sign in again to replace it.");
  }

  private async loadUnlocked(): Promise<TokenData | null> {
    const record = await this.readFile();
    if (!record) return null;
    if (record.version === 1) await this.assertLegacyUpgradePending();
    const token = await this.decode(record);
    if (record.version === 1) await this.saveUnlocked(token);
    return token;
  }

  private async saveUnlocked(token: TokenData): Promise<void> {
    if (!validToken(token)) throw new Error("Invalid session token.");
    await saveEncryptedRecord(this.sessionDir, this.sessionFilePath, "session", token, this.options);
  }

  private storeError(action: string, error: unknown): never {
    // A store error already carries the specific reason and the way out of it;
    // wrapping it again would bury both behind the generic sentence below.
    if (error instanceof SessionStoreError) throw error;
    if (error instanceof NativeCredentialStoreError || error instanceof AuthenticationInProgressError) throw error;
    throw new SessionStoreError(`Failed to ${action} session. Existing session data was preserved.`, error instanceof Error ? error : new Error(String(error)));
  }

  async save(token: TokenData): Promise<void> {
    try {
      await this.withWriteLock(async () => {
        const current = await this.readFile();
        if (current) await this.decode(current);
        await this.saveUnlocked(token);
      });
    } catch (error) {
      this.storeError("save", error);
    }
  }

  /** Missing files return null. Damaged or inaccessible secrets fail without MFA. */
  async load(): Promise<TokenData | null> {
    try {
      const record = await this.readFile();
      if (!record) return null;
      if (record.version === 1) return await this.withWriteLock(() => this.loadUnlocked());
      return await this.decode(record);
    } catch (error) {
      this.storeError("load", error);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.withWriteLock(async () => {
        const current = await this.readFile();
        if (!current) return;
        await this.decode(current);
        await trashFile(this.sessionFilePath, this.options);
      });
    } catch (error) {
      this.storeError("clear", error);
    }
  }

  /** Prevent a slow mint from replacing credentials saved by a newer login. */
  async saveIfCurrent(token: TokenData, expected: TokenData | null): Promise<boolean> {
    try {
      return await this.withWriteLock(async () => {
        if (!equalToken(await this.loadUnlocked(), expected)) return false;
        await this.saveUnlocked(token);
        return true;
      });
    } catch (error) {
      this.storeError("save", error);
    }
  }

  async clearIfCurrent(expected: TokenData): Promise<boolean> {
    try {
      return await this.withWriteLock(async () => {
        if (!equalToken(await this.loadUnlocked(), expected)) return false;
        await trashFile(this.sessionFilePath, this.options);
        return true;
      });
    } catch (error) {
      this.storeError("clear", error);
    }
  }
}
