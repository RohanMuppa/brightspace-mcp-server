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

  it("moves up a unit when rounding reaches the next unit's size", () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(dueIn(at(59.6 * 60 * 1000))).toBe("in 1 hour");
    expect(dueIn(at(23.6 * 60 * 60 * 1000))).toBe("tomorrow");
    expect(dueIn(at(6.6 * 24 * 60 * 60 * 1000))).toBe("next week");
    expect(dueIn(at(-59.6 * 60 * 1000))).toBe("1 hour ago");
    expect(dueIn(at(-23.6 * 60 * 60 * 1000))).toBe("yesterday");
    expect(dueIn(at(-6.6 * 24 * 60 * 60 * 1000))).toBe("last week");
  });

  it("keeps the smaller unit just below a boundary", () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(dueIn(at(59.4 * 60 * 1000))).toBe("in 59 minutes");
    expect(dueIn(at(23.4 * 60 * 60 * 1000))).toBe("in 23 hours");
    expect(dueIn(at(6.4 * 24 * 60 * 60 * 1000))).toBe("in 6 days");
  });

  it("renders a due date at the current instant as this minute", () => {
    expect(dueIn(NOW.toISOString())).toBe("this minute");
  });

  it("accepts an explicit now instead of the system clock", () => {
    const explicitNow = NOW.getTime() - 60 * 60 * 1000;
    expect(dueIn(NOW.toISOString(), explicitNow)).toBe("in 1 hour");
  });
});
