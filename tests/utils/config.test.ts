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
import { accountSessionDirectory, loadConfig } from "../../src/utils/config.js";

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
});
