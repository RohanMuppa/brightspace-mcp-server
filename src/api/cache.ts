/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// In-memory TTL cache using Map + setTimeout
// No disk persistence per user decision

interface CacheEntry<T> {
  data: T;
  timerId: NodeJS.Timeout;
}

export class TTLCache<T = unknown> {
  private cache = new Map<string, CacheEntry<T>>();

  set(key: string, value: T, ttlMs: number): void {
    // Clear existing timer if key exists
    const existing = this.cache.get(key);
    if (existing) {
      clearTimeout(existing.timerId);
    }

    // Set new timer to auto-delete after TTL
    const timerId = setTimeout(() => {
      this.cache.delete(key);
    }, ttlMs);
    // An idle cache entry must not hold the process open: a one hour
    // enrollments TTL would otherwise keep the event loop alive after the
    // last request has been answered.
    if (typeof (timerId as { unref?: () => void }).unref === "function") {
      (timerId as { unref: () => void }).unref();
    }

    // Store entry
    this.cache.set(key, { data: value, timerId });
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    return entry?.data;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      clearTimeout(entry.timerId);
      this.cache.delete(key);
      return true;
    }
    return false;
  }

  clear(): void {
    // Clear all timers
    for (const entry of this.cache.values()) {
      clearTimeout(entry.timerId);
    }
    // Clear map
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
