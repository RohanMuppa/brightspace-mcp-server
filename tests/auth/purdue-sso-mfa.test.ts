import { describe, it, expect, vi, afterEach } from "vitest";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import { BrowserAuthError } from "../../src/utils/errors.js";

/**
 * Purdue's Entra tenant uses number matching: a two-digit number appears on
 * screen and has to be typed into Microsoft Authenticator. Nothing surfaces it
 * unless the MFA wait scrapes it, and a headless run has no screen at all, so
 * the sign-in simply cannot be completed without this.
 *
 * Entra re-mints the number when the user asks for a new request, so only a
 * CHANGED value is worth a line: repeating the same digits every two seconds
 * buries the log.
 */

const SIGN_SELECTOR = "#idRichContext_DisplaySign";

/** WARN lines the logger actually emitted, which it writes to stderr. */
function captureWarnings() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("[WARN]")) lines.push(first);
  });
  return { lines, spy };
}

/**
 * Fake Page whose number-match element yields the given values in turn. The
 * post-MFA redirect lands once the list is exhausted, which is what ends the
 * poll in a real run too.
 */
function makeMfaPage(values: Array<string | null>) {
  let reads = 0;
  let arrive: () => void = () => {};
  const redirect = new Promise<void>((resolve) => {
    arrive = resolve;
  });

  const page = {
    url: vi.fn(() => "https://login.microsoftonline.com/common/kmsi"),
    waitForURL: vi.fn(() => redirect),
    waitForTimeout: vi.fn(async () => {}),
    locator: vi.fn((selector: string) => ({
      first: () => ({
        isVisible: async () => selector === SIGN_SELECTOR && reads < values.length,
        textContent: async () => {
          const value = values[reads];
          reads += 1;
          if (reads >= values.length) arrive();
          return value;
        },
      }),
    })),
  };

  return { page, reads: () => reads };
}

describe("PurdueSSOFlow.handleMFA number matching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const handleMFA = (page: unknown): Promise<void> =>
    (new PurdueSSOFlow({}) as any).handleMFA(page);

  it("logs the number match once per change, not once per poll", async () => {
    const { lines } = captureWarnings();
    const { page } = makeMfaPage(["42", "42", "73"]);

    await handleMFA(page);

    const numbers = lines.filter((line) => line.includes("Number match:"));
    expect(numbers).toHaveLength(2);
    expect(numbers[0]).toContain("Number match: 42.");
    expect(numbers[1]).toContain("Number match: 73.");
    expect(numbers[0]).toContain("Microsoft Authenticator");
  });

  it("stays quiet when the tenant shows no number", async () => {
    const { lines } = captureWarnings();
    const { page } = makeMfaPage([null, null]);

    await handleMFA(page);

    expect(lines.filter((line) => line.includes("Number match:"))).toHaveLength(0);
  });

  it("reports the five-minute budget when MFA is never approved", async () => {
    captureWarnings();
    const page = {
      url: vi.fn(() => "https://login.microsoftonline.com/common/kmsi"),
      waitForURL: vi.fn(async () => {
        throw new Error("Timeout 300000ms exceeded");
      }),
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn(() => ({
        first: () => ({
          isVisible: async () => false,
          textContent: async () => null,
        }),
      })),
    };

    await expect(handleMFA(page)).rejects.toBeInstanceOf(BrowserAuthError);
    await expect(handleMFA(page)).rejects.toThrow(/5 minutes/);
  });
});
