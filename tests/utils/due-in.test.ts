import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dueIn } from "../../src/utils/due-in.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

describe("dueIn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for a missing due date", () => {
    expect(dueIn(null)).toBeNull();
    expect(dueIn(undefined)).toBeNull();
    expect(dueIn("")).toBeNull();
  });

  it("returns null for an unparseable due date instead of throwing", () => {
    expect(() => dueIn("not-a-date")).not.toThrow();
    expect(dueIn("not-a-date")).toBeNull();
  });

  it("renders a future date under an hour away in minutes", () => {
    expect(dueIn(new Date(NOW.getTime() + 15 * 60 * 1000).toISOString())).toBe("in 15 minutes");
  });

  it("renders a past date under an hour away in minutes", () => {
    expect(dueIn(new Date(NOW.getTime() - 5 * 60 * 1000).toISOString())).toBe("5 minutes ago");
  });

  it("renders a future date under a day away in hours", () => {
    expect(dueIn(new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString())).toBe("in 2 hours");
  });

  it("renders a future date under a week away in days", () => {
    expect(dueIn(new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString())).toBe("in 3 days");
  });

  it("renders yesterday and tomorrow using Intl's special-cased day wording", () => {
    expect(dueIn(new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString())).toBe("yesterday");
    expect(dueIn(new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString())).toBe("tomorrow");
  });

  it("renders a date a week or more away in weeks", () => {
    expect(dueIn(new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString())).toBe("in 2 weeks");
  });

  it("renders a due date at the current instant as this minute", () => {
    expect(dueIn(NOW.toISOString())).toBe("this minute");
  });

  it("accepts an explicit now instead of the system clock", () => {
    const explicitNow = NOW.getTime() - 60 * 60 * 1000;
    expect(dueIn(NOW.toISOString(), explicitNow)).toBe("in 1 hour");
  });
});
