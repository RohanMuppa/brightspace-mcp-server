import { describe, it, expect } from "vitest";
import { causeSummaries } from "../../src/auth/error-cause.js";

describe("causeSummaries", () => {
  it("lists each cause once, first line only, outermost first", () => {
    const inner = new Error("Execution context was destroyed\nCall log:\n  - secret detail");
    const outer = new Error("wrapper", { cause: new Error("middle", { cause: inner }) });
    expect(causeSummaries(outer)).toEqual(["middle", "Execution context was destroyed"]);
  });

  it("cuts URLs to their origin so tokens in paths and queries never reach the log", () => {
    const error = new Error("top", { cause: new Error("goto https://school.example.edu/d2l/home?token=abc123&x=1 failed") });
    const [line] = causeSummaries(error);
    expect(line).toBe("goto https://school.example.edu failed");
    expect(line).not.toContain("abc123");
  });

  it("is empty without a cause, survives cycles, and caps the depth", () => {
    expect(causeSummaries(new Error("plain"))).toEqual([]);
    expect(causeSummaries("not an error")).toEqual([]);
    const a: Error & { cause?: unknown } = new Error("a");
    a.cause = a;
    expect(causeSummaries(a)).toEqual([]);
    let deep: Error = new Error("0");
    for (let i = 1; i < 10; i++) deep = new Error(String(i), { cause: deep });
    expect(causeSummaries(deep)).toHaveLength(4);
  });
});
