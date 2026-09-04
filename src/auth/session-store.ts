/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TokenData, EncryptedData, SessionFile } from "../types/index.js";
import { SessionStoreError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { writeFileAtomic } from "../utils/atomic-write.js";

const DEFAULT_SESSION_DIR = path.join(os.homedir(), ".d2l-session");
const SESSION_FILE_NAME = "session.json";
const SESSION_VERSION = 1;

// Encryption constants
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recommended IV length
const AUTH_TAG_LENGTH = 16; // GCM auth tag length
const SALT_LENGTH = 16;
const SALT_FILE_NAME = "salt";

/**
 * SessionStore manages encrypted token persistence to disk.
 * Uses AES-256-GCM for encryption with a key derived from username + hostname.
 */
export class SessionStore {
  private readonly sessionDir: string;
  private readonly sessionFilePath: string;

  constructor(sessionDir?: string) {
    this.sessionDir = sessionDir ?? DEFAULT_SESSION_DIR;
    this.sessionFilePath = path.join(this.sessionDir, SESSION_FILE_NAME);
  }

  /**
   * Get or create a random salt unique to this installation.
   * Stored at ~/.d2l-session/salt with restricted permissions.
   */
  private getOrCreateSalt(): Buffer {
    const saltPath = path.join(this.sessionDir, SALT_FILE_NAME);
    try {
      return fsSync.readFileSync(saltPath);
    } catch {
      // Salt doesn't exist yet — create session dir and generate one
      const isWindows = process.platform === "win32";
      fsSync.mkdirSync(this.sessionDir, {
        recursive: true,
        ...(isWindows ? {} : { mode: 0o700 }),
      });
      const salt = crypto.randomBytes(SALT_LENGTH);
      fsSync.writeFileSync(saltPath, salt, {
        ...(isWindows ? {} : { mode: 0o600 }),
      });
      return salt;
    }
  }

  /**
   * Derive AES-256 key from username and hostname using scrypt.
   * Uses a per-installation random salt to prevent precomputation attacks.
   */
  private deriveKey(): Buffer {
    const username = os.userInfo().username;
    const hostname = os.hostname();
    const keyMaterial = username + hostname;
    const salt = this.getOrCreateSalt();

    // Use scrypt to derive a 32-byte key (256 bits for AES-256)
    return crypto.scryptSync(keyMaterial, salt, 32);
  }

  /**
   * Encrypt plaintext using AES-256-GCM.
   * Returns IV, auth tag, and ciphertext as hex strings.
   */
  private encrypt(plaintext: string): EncryptedData {
    const key = this.deriveKey();
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      data: encrypted,
    };
  }

  /**
   * Decrypt ciphertext using AES-256-GCM.
   * Returns plaintext string, or throws if auth tag verification fails.
   */
  private decrypt(encrypted: EncryptedData): string {
    const key = this.deriveKey();
    const iv = Buffer.from(encrypted.iv, "hex");
    const authTag = Buffer.from(encrypted.authTag, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted.data, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }

  /**
   * Save token to disk with encryption.
   * Creates session directory if it doesn't exist.
   */
  async save(token: TokenData): Promise<void> {
    try {
      // Ensure session directory exists with restricted permissions (owner-only on Unix)
      const isWindows = process.platform === "win32";
      await fs.mkdir(this.sessionDir, {
        recursive: true,
        ...(isWindows ? {} : { mode: 0o700 }),
      });

      const plaintext = JSON.stringify(token);
      const encrypted = this.encrypt(plaintext);

      const sessionFile: SessionFile = {
        version: SESSION_VERSION,
        encrypted,
        createdAt: Date.now(),
        expiresAt: token.expiresAt,
      };

      // Staged and renamed, so the auth CLI and a running server can never
      // leave each other a half-written file.
      await writeFileAtomic(
        this.sessionFilePath,
        JSON.stringify(sessionFile, null, 2),
        isWindows ? {} : { mode: 0o600 }
      );

      log("DEBUG", `Session saved to ${this.sessionFilePath}`);
    } catch (error) {
      const err =
        error instanceof Error ? error : new Error(String(error));
      log("ERROR", `Failed to save session: ${err.message}`);
      throw new SessionStoreError("Failed to save session", err);
    }
  }

  /**
   * Load token from disk with decryption.
   * Returns null if file doesn't exist or is corrupted (graceful degradation).
   */
  async load(): Promise<TokenData | null> {
    try {
      // Check if file exists
      try {
        await fs.access(this.sessionFilePath);
      } catch {
        log("DEBUG", "No session file found");
        return null;
      }

      // Read and parse session file
      const fileContent = await fs.readFile(this.sessionFilePath, "utf-8");
      const sessionFile: SessionFile = JSON.parse(fileContent);

      // Decrypt token data
      const plaintext = this.decrypt(sessionFile.encrypted);
      const token: TokenData = JSON.parse(plaintext);

      log("DEBUG", `Session loaded from ${this.sessionFilePath}`);
      return token;
    } catch (error) {
      const err =
        error instanceof Error ? error : new Error(String(error));
      log("WARN", `Failed to load session: ${err.message}`);
      // Return null instead of throwing - graceful degradation
      return null;
    }
  }

  /**
   * Clear session by deleting the session file.
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.sessionFilePath);
      log("DEBUG", `Session cleared: ${this.sessionFilePath}`);
    } catch (error: any) {
      // Ignore ENOENT errors - file already doesn't exist
      if (error.code !== "ENOENT") {
        const err =
          error instanceof Error ? error : new Error(String(error));
        log("WARN", `Failed to clear session: ${err.message}`);
      }
    }
  }
}
