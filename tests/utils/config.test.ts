import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";

const fake = vi.hoisted(() => ({
  dotenv: vi.fn(), password: vi.fn(), migrate: vi.fn(),
  store: null as Record<string, unknown> | null,
}));
vi.mock("dotenv", () => ({ default: { config: fake.dotenv } }));
vi.mock("../../src/utils/config-store.js", () => ({
  configStoreExists: () => fake.store !== null,
  loadConfigStore: () => fake.store,
}));
vi.mock("../../src/utils/secure-config.js", () => ({ resolveStoredPassword: fake.password }));
vi.mock("../../src/auth/legacy-state.js", () => ({ migrateLegacyState: fake.migrate }));
import { accountSessionDirectory, loadConfig, parseSessionCookieEnv, readEnvSecret } from "../../src/utils/config.js";

describe("resolved authentication configuration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const key of Object.keys(process.env).filter(key => key.startsWith("D2L_"))) vi.stubEnv(key, undefined);
    fake.store = null;
    fake.password.mockResolvedValue("native-password");
    fake.migrate.mockResolvedValue({ tokenState: "absent", browserState: "encrypted" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("loads .env before deriving the account path inherited by the auth child", async () => {
    const root = path.resolve("fixture-sessions");
    fake.dotenv.mockImplementation(() => {
      vi.stubEnv("D2L_BASE_URL", "https://school.example/path");
      vi.stubEnv("D2L_USERNAME", "alice");
      vi.stubEnv("D2L_SESSION_DIR", root);
      vi.stubEnv("D2L_HEADLESS", "false");
    });
    const config = await loadConfig();
    expect(config).toMatchObject({
      baseUrl: "https://school.example", username: "alice", password: "native-password",
      sessionRoot: root, sessionDir: accountSessionDirectory(root, "https://school.example", "alice"), headless: false,
    });
    expect(fake.dotenv).toHaveBeenCalledWith({ quiet: true });
    expect(fake.password).toHaveBeenCalledWith("https://school.example", "alice", null);
    expect(fake.migrate).toHaveBeenCalledWith(root);
    expect(config.legacyBrowserStateMigrated).toBe(true);
  });

  it("uses the setup MFA preference when no environment override is present", async () => {
    fake.store = { baseUrl: "https://school.example", username: "alice", headless: false };
    expect(await loadConfig()).toMatchObject({ headless: false });
  });

  it("rejects credential-bearing URLs before accessing native storage", async () => {
    vi.stubEnv("D2L_BASE_URL", "https://alice:secret@school.example");
    await expect(loadConfig()).rejects.toThrow("without embedded credentials");
    expect(fake.password).not.toHaveBeenCalled();
  });
  it("uses a positive whole-second D2L_TOKEN_TTL", async () => {
    vi.stubEnv("D2L_TOKEN_TTL", " 900 ");
    expect(await loadConfig()).toMatchObject({ tokenTtl: 900 });
  });

  it.each(["abc", "0", "-5", "1h", "1.5"])("ignores D2L_TOKEN_TTL=%s and falls back to config.json", async (value) => {
    vi.stubEnv("D2L_TOKEN_TTL", value);
    fake.store = { tokenTtl: 1800 };
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadConfig()).toMatchObject({ tokenTtl: 1800 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring D2L_TOKEN_TTL"));
    warn.mockRestore();
  });

  it("falls back to the default when both sources are invalid", async () => {
    vi.stubEnv("D2L_TOKEN_TTL", "abc");
    fake.store = { tokenTtl: -1 };
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadConfig()).toMatchObject({ tokenTtl: 3600 });
    warn.mockRestore();
  });

  it.each([
    ["false", false], ["False", false], [" FALSE ", false], ["0", false], ["no", false], ["off", false],
    ["true", true], ["TRUE", true], ["1", true], ["yes", true], ["on", true],
  ])("reads D2L_HEADLESS=%j as %s", async (value, expected) => {
    vi.stubEnv("D2L_HEADLESS", value);
    fake.store = { headless: !expected };
    expect(await loadConfig()).toMatchObject({ headless: expected });
  });

  it.each([
    ["0", false], ["No", false], ["1", true], ["Yes", true],
  ])("reads D2L_ACTIVE_ONLY=%j as %s", async (value, expected) => {
    vi.stubEnv("D2L_ACTIVE_ONLY", value);
    fake.store = { activeOnly: !expected };
    expect((await loadConfig()).courseFilter.activeOnly).toBe(expected);
  });

  it("leaves Microsoft's remember-MFA checkbox alone unless D2L_REMEMBER_MFA opts in", async () => {
    expect((await loadConfig()).rememberMfa).toBe(false);
  });

  it.each([
    ["false", false], ["0", false], ["true", true], ["1", true],
  ])("reads D2L_REMEMBER_MFA=%j as %s", async (value, expected) => {
    vi.stubEnv("D2L_REMEMBER_MFA", value);
    expect((await loadConfig()).rememberMfa).toBe(expected);
  });

  it("treats an empty D2L_HEADLESS as unset so the setup preference applies", async () => {
    vi.stubEnv("D2L_HEADLESS", "");
    fake.store = { headless: false };
    expect(await loadConfig()).toMatchObject({ headless: false });
  });

  it("ignores an unrecognized D2L_HEADLESS with a warning and falls back to config.json", async () => {
    vi.stubEnv("D2L_HEADLESS", "flase");
    fake.store = { headless: false };
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadConfig()).toMatchObject({ headless: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring D2L_HEADLESS="flase"'));
    warn.mockRestore();
  });

  it("ignores an unrecognized D2L_ACTIVE_ONLY and keeps the default", async () => {
    vi.stubEnv("D2L_ACTIVE_ONLY", "maybe");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await loadConfig()).courseFilter.activeOnly).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring D2L_ACTIVE_ONLY"));
    warn.mockRestore();
  });

  describe("D2L_SESSION_COOKIE / D2L_ACCESS_TOKEN (browser-free sign-in)", () => {
    it("leaves both unset by default — byte-identical to today", async () => {
      const config = await loadConfig();
      expect(config.envAccessToken).toBeUndefined();
      expect(config.envSessionCookie).toBeUndefined();
    });

    it("normalizes a full cookie-header D2L_SESSION_COOKIE", async () => {
      vi.stubEnv("D2L_SESSION_COOKIE", "d2lSessionVal=aaa; d2lSecureSessionVal=bbb");
      const config = await loadConfig();
      expect(config.envSessionCookie).toBe("d2lSessionVal=aaa; d2lSecureSessionVal=bbb");
      expect(config.envAccessToken).toBeUndefined();
    });

    it("accepts the cookie names in either order and ignores extra cookies", async () => {
      vi.stubEnv("D2L_SESSION_COOKIE", "other=ignored; d2lSecureSessionVal=bbb; d2lSessionVal=aaa");
      const config = await loadConfig();
      expect(config.envSessionCookie).toBe("d2lSessionVal=aaa; d2lSecureSessionVal=bbb");
    });

    it("accepts the two raw values separated by a semicolon, in order", async () => {
      vi.stubEnv("D2L_SESSION_COOKIE", "aaa;bbb");
      const config = await loadConfig();
      expect(config.envSessionCookie).toBe("d2lSessionVal=aaa; d2lSecureSessionVal=bbb");
    });

    it("rejects a D2L_SESSION_COOKIE missing one of the two cookies", async () => {
      vi.stubEnv("D2L_SESSION_COOKIE", "d2lSessionVal=aaa");
      await expect(loadConfig()).rejects.toThrow("D2L_SESSION_COOKIE must be either");
    });

    it("rejects an unparseable D2L_SESSION_COOKIE", async () => {
      vi.stubEnv("D2L_SESSION_COOKIE", "just-one-value");
      await expect(loadConfig()).rejects.toThrow("D2L_SESSION_COOKIE must be either");
    });

    it("treats an empty D2L_SESSION_COOKIE as unset", async () => {
      vi.stubEnv("D2L_SESSION_COOKIE", "");
      const config = await loadConfig();
      expect(config.envSessionCookie).toBeUndefined();
    });

    it("passes D2L_ACCESS_TOKEN through unchanged", async () => {
      vi.stubEnv("D2L_ACCESS_TOKEN", "a-valence-token");
      const config = await loadConfig();
      expect(config.envAccessToken).toBe("a-valence-token");
    });

    it("sets both when both are present — precedence is resolved downstream, not at config load", async () => {
      vi.stubEnv("D2L_ACCESS_TOKEN", "a-valence-token");
      vi.stubEnv("D2L_SESSION_COOKIE", "aaa;bbb");
      const config = await loadConfig();
      expect(config.envAccessToken).toBe("a-valence-token");
      expect(config.envSessionCookie).toBe("d2lSessionVal=aaa; d2lSecureSessionVal=bbb");
    });

    it.each(["D2L_ACCESS_TOKEN", "D2L_SESSION_COOKIE"])(
      "rejects %s containing a CRLF",
      async (varName) => {
        vi.stubEnv(varName, "aaa\r\nbbb");
        await expect(loadConfig()).rejects.toThrow(/carriage return|line feed/);
      },
    );

    // Node truncates process.env values at an embedded NUL before user code
    // ever sees them (vi.stubEnv("D2L_ACCESS_TOKEN", "aaa\0bbb") arrives as
    // just "aaa"), so the NUL branch is exercised directly against the
    // validator rather than through loadConfig()/process.env.
    it("rejects a value containing an embedded NUL", () => {
      expect(() => readEnvSecret("aaa\0bbb", "D2L_ACCESS_TOKEN")).toThrow(/NUL/);
    });

    it.each(["D2L_ACCESS_TOKEN", "D2L_SESSION_COOKIE"])(
      "rejects %s with leading or trailing whitespace instead of silently trimming it",
      async (varName) => {
        vi.stubEnv(varName, varName === "D2L_SESSION_COOKIE" ? " aaa;bbb" : " a-valence-token ");
        await expect(loadConfig()).rejects.toThrow(/leading or trailing whitespace/);
      },
    );

    it("never includes the secret value in the thrown error message", async () => {
      vi.stubEnv("D2L_ACCESS_TOKEN", "super-secret-token-value\r\n");
      await expect(loadConfig()).rejects.toThrow();
      try {
        await loadConfig();
        throw new Error("expected loadConfig to reject");
      } catch (error) {
        expect((error as Error).message).not.toContain("super-secret-token-value");
      }
    });
  });

  describe("parseSessionCookieEnv", () => {
    it("normalizes the named cookie-header form", () => {
      expect(parseSessionCookieEnv("d2lSessionVal=aaa; d2lSecureSessionVal=bbb"))
        .toBe("d2lSessionVal=aaa; d2lSecureSessionVal=bbb");
    });

    it("normalizes the two-raw-values form", () => {
      expect(parseSessionCookieEnv("aaa;bbb")).toBe("d2lSessionVal=aaa; d2lSecureSessionVal=bbb");
    });

    it("normalizes the two-raw-values form when the second value has base64 padding", () => {
      // "xyz==" contains an "=" that is not a cookie name -- the form must be
      // decided by whether a segment is NAMED d2lSessionVal/d2lSecureSessionVal,
      // not by whether any "=" appears in it.
      expect(parseSessionCookieEnv("abc;xyz==")).toBe("d2lSessionVal=abc; d2lSecureSessionVal=xyz==");
    });

    it("tolerates extra whitespace around semicolons and equals signs", () => {
      expect(parseSessionCookieEnv(" d2lSessionVal = aaa ;  d2lSecureSessionVal = bbb "))
        .toBe("d2lSessionVal=aaa; d2lSecureSessionVal=bbb");
    });

    it("throws a clear error for garbage input", () => {
      expect(() => parseSessionCookieEnv("not-a-cookie-header")).toThrow("D2L_SESSION_COOKIE must be either");
    });
  });
});
