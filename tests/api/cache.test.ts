import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TTLCache } from "../../src/api/cache.js";

describe("TTLCache", () => {
  let cache: TTLCache<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new TTLCache<string>();
  });

  afterEach(() => {
    cache.clear();
    vi.useRealTimers();
  });

  it("should store and retrieve values before expiry", () => {
    cache.set("key1", "value1", 1000);
    expect(cache.get("key1")).toBe("value1");
    expect(cache.has("key1")).toBe(true);
  });

  it("should return undefined for missing key", () => {
    expect(cache.get("nonexistent")).toBeUndefined();
    expect(cache.has("nonexistent")).toBe(false);
  });

  it("should expire entries after TTL", () => {
    cache.set("key1", "value1", 1000);
    expect(cache.get("key1")).toBe("value1");

    // Advance time past TTL
    vi.advanceTimersByTime(1001);

    expect(cache.get("key1")).toBeUndefined();
    expect(cache.has("key1")).toBe(false);
  });

  it("should correctly overwrite existing entries and reset TTL", () => {
    cache.set("key1", "value1", 1000);
    expect(cache.get("key1")).toBe("value1");

    // Advance time but not past expiry
    vi.advanceTimersByTime(500);

    // Overwrite with new value and new TTL
    cache.set("key1", "value2", 2000);
    expect(cache.get("key1")).toBe("value2");

    // Advance past original TTL but not new TTL
    vi.advanceTimersByTime(600);
    expect(cache.get("key1")).toBe("value2");

    // Advance past new TTL
    vi.advanceTimersByTime(1500);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("reports how long ago an entry was written", () => {
    cache.set("key1", "value1", 1_800_000);
    expect(cache.ageOf("key1")).toBe(0);
    expect(cache.ageOf("nonexistent")).toBeUndefined();

    vi.advanceTimersByTime(900_000);

    // Still live under its own 30 minute TTL, but half an hour of course
    // content is fifteen minutes of due dates to a caller that asked for less.
    expect(cache.has("key1")).toBe(true);
    expect(cache.ageOf("key1")).toBe(900_000);

    cache.set("key1", "value2", 1_800_000);
    expect(cache.ageOf("key1")).toBe(0);
  });

  it("should delete entry and clear timer", () => {
    cache.set("key1", "value1", 5000);
    expect(cache.has("key1")).toBe(true);

    const deleted = cache.delete("key1");
    expect(deleted).toBe(true);
    expect(cache.has("key1")).toBe(false);
    expect(cache.get("key1")).toBeUndefined();

    // Deleting non-existent key returns false
    const deletedAgain = cache.delete("key1");
    expect(deletedAgain).toBe(false);
  });

  it("should clear all entries", () => {
    cache.set("key1", "value1", 1000);
    cache.set("key2", "value2", 2000);
    cache.set("key3", "value3", 3000);

    expect(cache.size).toBe(3);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBeUndefined();
    expect(cache.get("key3")).toBeUndefined();
  });

  it("should return correct size", () => {
    expect(cache.size).toBe(0);

    cache.set("key1", "value1", 1000);
    expect(cache.size).toBe(1);

    cache.set("key2", "value2", 1000);
    expect(cache.size).toBe(2);

    cache.delete("key1");
    expect(cache.size).toBe(1);

    // Entry expiring should decrease size
    vi.advanceTimersByTime(1001);
    expect(cache.size).toBe(0);
  });

  it("should handle multiple entries with different TTLs", () => {
    cache.set("short", "value1", 100);
    cache.set("medium", "value2", 500);
    cache.set("long", "value3", 1000);

    expect(cache.size).toBe(3);

    // Advance past short TTL
    vi.advanceTimersByTime(101);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("medium")).toBe("value2");
    expect(cache.get("long")).toBe("value3");

    // Advance past medium TTL
    vi.advanceTimersByTime(400);
    expect(cache.get("medium")).toBeUndefined();
    expect(cache.get("long")).toBe("value3");

    // Advance past long TTL
    vi.advanceTimersByTime(500);
    expect(cache.get("long")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
