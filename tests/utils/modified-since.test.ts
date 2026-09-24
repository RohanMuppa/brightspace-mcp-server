import { describe, it, expect } from "vitest";
import { matchesModifiedSince } from "../../src/utils/modified-since.js";

describe("matchesModifiedSince", () => {
  const cutoff = new Date("2026-09-15T00:00:00.000Z");

  it("matches a timestamp at exactly the cutoff", () => {
    expect(matchesModifiedSince("2026-09-15T00:00:00.000Z", cutoff)).toBe(true);
  });

  it("matches a timestamp after the cutoff", () => {
    expect(matchesModifiedSince("2026-09-20T00:00:00.000Z", cutoff)).toBe(true);
  });

  it("excludes a timestamp before the cutoff", () => {
    expect(matchesModifiedSince("2026-09-01T00:00:00.000Z", cutoff)).toBe(false);
  });

  it("includes a null timestamp rather than dropping it", () => {
    expect(matchesModifiedSince(null, cutoff)).toBe(true);
  });

  it("includes an undefined timestamp rather than dropping it", () => {
    expect(matchesModifiedSince(undefined, cutoff)).toBe(true);
  });

  it("includes an unparseable timestamp rather than dropping it", () => {
    expect(matchesModifiedSince("not-a-date", cutoff)).toBe(true);
  });

  it("compares across timezone offsets correctly", () => {
    // 2026-09-15T02:00:00+02:00 is 2026-09-15T00:00:00Z — exactly the cutoff.
    expect(matchesModifiedSince("2026-09-15T02:00:00+02:00", cutoff)).toBe(true);
    // One second earlier in UTC terms should not match.
    expect(matchesModifiedSince("2026-09-15T01:59:59+02:00", cutoff)).toBe(false);
  });
});
