/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EncryptedData } from "../types/index.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { getSessionEncryptionKey, type CredentialBackend } from "./credential-store.js";

export interface SecureStoreOptions {
  backend?: CredentialBackend;
  /** Allows migration failures to be tested without changing real secrets. */
  write?: typeof writeFileAtomic;
  trash?: (file: string) => Promise<void>;
}

export interface EncryptedRecord {
  version: 2;
  kind: "session" | "browser-state";
  encrypted: EncryptedData;
}

export function encrypt(plaintext: string, key: Buffer, aad?: string): EncryptedData {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), authTag: cipher.getAuthTag().toString("hex"), data: data.toString("hex") };
}

export function decrypt(encrypted: EncryptedData, key: Buffer, aad?: string): string {
  if (!encrypted || !/^[a-f0-9]{24}$/i.test(encrypted.iv) || !/^[a-f0-9]{32}$/i.test(encrypted.authTag) || !/^(?:[a-f0-9]{2})+$/i.test(encrypted.data)) {
    throw new Error("Invalid encrypted authentication state.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "hex"));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.data, "hex")), decipher.final()]).toString("utf8");
}

function associatedData(kind: EncryptedRecord["kind"]): string {
  return `brightspace-mcp-server:2:${kind}`;
}

export async function readEncryptedRecord<T>(sessionDir: string, record: EncryptedRecord, kind: EncryptedRecord["kind"], options: SecureStoreOptions): Promise<T> {
  if (record.version !== 2 || record.kind !== kind) throw new Error("Unsupported encrypted authentication state format.");
  const key = await getSessionEncryptionKey(sessionDir, options.backend, false);
  return JSON.parse(decrypt(record.encrypted, key, associatedData(kind))) as T;
}

export async function saveEncryptedRecord(sessionDir: string, file: string, kind: EncryptedRecord["kind"], value: unknown, options: SecureStoreOptions): Promise<void> {
  const key = await getSessionEncryptionKey(sessionDir, options.backend);
  const plaintext = JSON.stringify(value);
  const record: EncryptedRecord = { version: 2, kind, encrypted: encrypt(plaintext, key, associatedData(kind)) };
  if (decrypt(record.encrypted, key, associatedData(kind)) !== plaintext) throw new Error("Encrypted state verification failed.");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await (options.write ?? writeFileAtomic)(file, JSON.stringify(record), {
    mode: 0o600,
    renameImpl: async (from, to) => {
      await readEncryptedRecord(sessionDir, JSON.parse(await fs.readFile(from, "utf8")), kind, options);
      await fs.rename(from, to);
    },
  });
  // Verify the actual saved ciphertext before a caller retires legacy state.
  await readEncryptedRecord(sessionDir, JSON.parse(await fs.readFile(file, "utf8")), kind, options);
}

export async function trashFile(file: string, options: SecureStoreOptions): Promise<void> {
  if (options.trash) return options.trash(file);
  const { default: trash } = await import("trash");
  // A literal path, never a pattern: a bracket or brace in the home directory
  // name must not be read as a glob.
  await trash(file, { glob: false });
}
