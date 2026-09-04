import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, setLogLevel } from "../../src/utils/logger.js";

/**
 * Everything that reaches console.error passes through the redactor,
 * including the variadic arguments, which used to be printed raw.
 */

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("log redaction", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setLogLevel("DEBUG");
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    setLogLevel("INFO");
  });

  const printed = () => spy.mock.calls.map((c) => c.join(" ")).join("\n");

  it("redacts a JWT inside an error argument", () => {
    log("ERROR", "request failed", new Error(`bad token ${JWT}`));
    const out = printed();
    expect(out).not.toContain(JWT);
    expect(out).toContain("REDACTED");
    expect(out).toContain("bad token");
  });

  it("redacts JSON-serialized Authorization and Cookie fields in an object argument", () => {
    log("DEBUG", "headers", {
      Authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      Cookie: "d2lSessionVal=supersecretvalue1234567890",
      "Set-Cookie": "d2lSecureSessionVal=anothersecret1234567890; Path=/",
      Accept: "application/json",
    });
    const out = printed();
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("supersecretvalue1234567890");
    expect(out).not.toContain("anothersecret1234567890");
    expect(out).toContain("application/json");
  });

  it("redacts credentials embedded in a URL", () => {
    log("WARN", "fetching", "https://student:hunter2@purdue.brightspace.com/d2l/home");
    const out = printed();
    expect(out).not.toContain("hunter2");
    expect(out).toContain("purdue.brightspace.com");
  });

  it("leaves an ordinary course code alone", () => {
    log("INFO", "fetched ECE264 and MA26100", { course: "CS18000" });
    const out = printed();
    expect(out).toContain("ECE264");
    expect(out).toContain("MA26100");
    expect(out).toContain("CS18000");
    expect(out).not.toContain("REDACTED");
  });

  it("does not choke on a circular argument", () => {
    const a: Record<string, unknown> = { name: "loop" };
    a.self = a;
    expect(() => log("DEBUG", "circular", a)).not.toThrow();
    expect(printed()).toContain("loop");
  });

  it("still respects the log level", () => {
    setLogLevel("WARN");
    log("INFO", "hidden");
    expect(spy).not.toHaveBeenCalled();
  });
});
