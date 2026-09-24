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

  /**
   * The JSON-object form above was covered; the raw header form was not, and
   * the rule that was supposed to catch it could not fire on a real header.
   * It was case-sensitive, and it required the value to butt straight against
   * the colon -- so "Cookie: d2lSessionVal=..." printed in full.
   */
  it("redacts a raw Cookie header line, whatever its case", () => {
    log("DEBUG", "sending", "Cookie: d2lSessionVal=abc123def; d2lSecureSessionVal=topsecret");
    const out = printed();
    expect(out).not.toContain("abc123def");
    expect(out).not.toContain("topsecret");
    expect(out).toContain("REDACTED");
  });

  it("redacts a raw Set-Cookie header line", () => {
    log("WARN", "response", "set-cookie: d2lSessionVal=zzzsecretzzz; Path=/; HttpOnly");
    expect(printed()).not.toContain("zzzsecretzzz");
  });

  it("redacts every cookie on the header, not just the first", () => {
    log("DEBUG", "Cookie: a=1; sessionSecret=leakmeplease");
    expect(printed()).not.toContain("leakmeplease");
  });

  /**
   * The redactor's own docstring promises passwords and secrets, but it only
   * had rules for Authorization and Cookie. Anything that serialized a config
   * or credential object printed the password verbatim.
   */
  it("redacts a password field in a serialized object", () => {
    log("DEBUG", "resolved config", {
      username: "bob",
      password: "hunter2",
      school: "https://purdue.brightspace.com",
    });
    const out = printed();
    expect(out).not.toContain("hunter2");
    expect(out).toContain("bob");
    expect(out).toContain("REDACTED");
  });

  it("redacts token and secret fields whatever they are called", () => {
    log("DEBUG", "session", {
      accessToken: "tok_12345",
      refresh_token: "r_9876",
      xsrfToken: "x_5555",
      clientSecret: "s_4444",
      apiKey: "k_3333",
    });
    const out = printed();
    for (const secret of ["tok_12345", "r_9876", "x_5555", "s_4444", "k_3333"]) {
      expect(out).not.toContain(secret);
    }
  });

  it("leaves a numeric field next to a token field readable", () => {
    log("DEBUG", "session", { tokenExpiry: 1750000000 });
    expect(printed()).toContain("1750000000");
  });

  it("redacts a password in free text or a query string", () => {
    log("ERROR", "login failed for password=hunter2");
    log("ERROR", "posted ?username=bob&password=hunter3&remember=1");
    const out = printed();
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("hunter3");
    expect(out).toContain("remember=1");
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
