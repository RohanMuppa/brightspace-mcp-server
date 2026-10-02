/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT. See LICENSE file for details.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BrowserContext } from "playwright";
import { SessionStoreError } from "../utils/errors.js";
import { NativeCredentialStoreError } from "./credential-store.js";
import { readEncryptedRecord, saveEncryptedRecord, trashFile, type SecureStoreOptions } from "./encrypted-store.js";

export type BrowserState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const BROWSER_STATE_FILE = "storage-state.encrypted.json";

function validState(value: unknown): value is BrowserState {
  const state = value as BrowserState | null;
  return !!state && Array.isArray(state.cookies) && Array.isArray(state.origins)
    && state.cookies.every((cookie) => cookie && typeof cookie.name === "string" && typeof cookie.value === "string"
      && typeof cookie.domain === "string" && typeof cookie.path === "string" && Number.isFinite(cookie.expires)
      && typeof cookie.httpOnly === "boolean" && typeof cookie.secure === "boolean" && ["Strict", "Lax", "None"].includes(cookie.sameSite))
    && state.origins.every((origin) => origin && typeof origin.origin === "string" && Array.isArray(origin.localStorage)
      && origin.localStorage.every((item) => item && typeof item.name === "string" && typeof item.value === "string"));
}

export class BrowserStateStore {
  private readonly file: string;
  private readonly legacyFile: string;

  constructor(private readonly sessionDir: string, private readonly options: SecureStoreOptions = {}) {
    this.file = path.join(sessionDir, BROWSER_STATE_FILE);
    this.legacyFile = path.join(sessionDir, "storage-state.json");
  }

  private storeError(action: string, error: unknown): never {
    if (error instanceof NativeCredentialStoreError) throw error;
    throw new SessionStoreError(`Failed to ${action} browser session. Existing session data was preserved.`, error instanceof Error ? error : new Error(String(error)));
  }

  async load(): Promise<BrowserState | undefined> {
    try {
      let contents: string;
      let legacy = false;
      try {
        contents = await fs.readFile(this.file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          contents = await fs.readFile(this.legacyFile, "utf8");
          legacy = true;
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw legacyError;
        }
      }
      const state = legacy ? JSON.parse(contents) : await readEncryptedRecord(this.sessionDir, JSON.parse(contents), "browser-state", this.options);
      if (!validState(state)) throw new Error("Invalid saved browser state.");
      if (legacy) {
        await this.save(state);
        await trashFile(this.legacyFile, this.options);
      } else {
        // A prior migration can have committed encryption before Trash failed.
        try {
          const leftover = JSON.parse(await fs.readFile(this.legacyFile, "utf8"));
          if (!validState(leftover)) throw new Error("Invalid legacy browser state was preserved.");
          await trashFile(this.legacyFile, this.options);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return state;
    } catch (error) {
      this.storeError("load", error);
    }
  }

  async save(state: BrowserState): Promise<void> {
    try {
      if (!validState(state)) throw new Error("Invalid browser state.");
      try {
        const current = JSON.parse(await fs.readFile(this.file, "utf8"));
        await readEncryptedRecord(this.sessionDir, current, "browser-state", this.options);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await saveEncryptedRecord(this.sessionDir, this.file, "browser-state", state, this.options);
    } catch (error) {
      this.storeError("save", error);
    }
  }
}
