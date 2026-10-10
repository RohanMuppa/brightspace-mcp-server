import { describe, expect, it } from "vitest";
import { generateTotp, normalizeTotpEnrollment, secondsUntilFreshCode } from "../../src/auth/totp.js";

const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("Purdue authenticator codes", () => {
  it("matches RFC 6238 public SHA-1 vectors", () => {
    const uri = `otpauth://totp/Test?secret=${secret}&digits=8`;
    expect(generateTotp(uri, 59_000)).toBe("94287082");
    expect(generateTotp(uri, 1_111_111_109_000)).toBe("07081804");
    expect(generateTotp(uri, 1_234_567_890_000)).toBe("89005924");
  });

  it("accepts the same setup key format as the Chrome extension", () => {
    const uri = normalizeTotpEnrollment(secret.toLowerCase().match(/.{1,4}/g)!.join(" "), "alice");
    expect(generateTotp(uri, 59_000)).toBe("287082");
    expect(secondsUntilFreshCode(uri, 29_000)).toBe(1);
  });

  it("rejects a one-time code and malformed enrollment without revealing input", () => {
    expect(() => normalizeTotpEnrollment("123456", "alice")).toThrow("Invalid authenticator enrollment URI");
    expect(() => generateTotp("otpauth://totp/Test?secret=INVALID!", 59_000)).toThrow("Invalid authenticator enrollment URI");
  });
});
