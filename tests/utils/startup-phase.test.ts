import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startupPhase } from "../../src/utils/startup-phase.js";

/**
 * A client that times out during initialize can only tell where the server
 * stalled if each slow startup step announces itself before it is awaited.
 */
describe("startupPhase", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  const printed = () => spy.mock.calls.map((c) => c.join(" "));

  beforeEach(() => {
    vi.useFakeTimers();
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
    vi.useRealTimers();
  });

  it("announces the phase before its work starts", async () => {
    let seenAtStart: string[] = [];
    await startupPhase("reading the thing", async () => { seenAtStart = printed(); });
    expect(seenAtStart).toHaveLength(1);
    expect(seenAtStart[0]).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] \[INFO\] Startup: reading the thing\.\.\.$/);
  });

  it("returns the work's result and reports how long it took", async () => {
    const result = await startupPhase("reading the thing", async () => {
      await vi.advanceTimersByTimeAsync(1234);
      return 42;
    });
    expect(result).toBe(42);
    expect(printed().at(-1)).toContain("Startup: reading the thing done in 1234 ms");
  });

  it("warns exactly once while a phase is stuck, naming the phase", async () => {
    let finish!: () => void;
    const pending = startupPhase("reading the OS credential store", () => new Promise<void>((r) => { finish = r; }));
    await vi.advanceTimersByTimeAsync(60_000);
    const warnings = printed().filter((line) => line.includes("[WARN]"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Startup: still reading the OS credential store after 10 s");
    finish();
    await pending;
    expect(printed().at(-1)).toContain("done in 60000 ms");
  });

  it("says no stall warning when the phase finishes quickly", async () => {
    await startupPhase("reading the thing", async () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(printed().some((line) => line.includes("[WARN]"))).toBe(false);
  });

  it("reports the failure time and rethrows the original error", async () => {
    const boom = new Error("locked");
    await expect(startupPhase("reading the thing", async () => {
      await vi.advanceTimersByTimeAsync(50);
      throw boom;
    })).rejects.toBe(boom);
    expect(printed().at(-1)).toContain("Startup: reading the thing failed after 50 ms");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(printed().some((line) => line.includes("still"))).toBe(false);
  });
});
