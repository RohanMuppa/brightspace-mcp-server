import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A corrupt or permission-denied ~/.brightspace-mcp/config.json must not take
 * the whole server down at startup — env vars alone are a complete, if less
 * convenient, configuration. This file deliberately does NOT mock
 * config-store.js (unlike tests/utils/config.test.ts), so loadConfigStore()
 * runs for real over a temp HOME and JSON.parse genuinely throws the way it
 * would on a live machine. Idea from lmgveerhoek's fork (MIT).
 */

const fake = vi.hoisted(() => ({ password: vi.fn(), migrate: vi.fn() }));
vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));
vi.mock("../../src/utils/secure-config.js", () => ({ resolveStoredPassword: fake.password }));
vi.mock("../../src/auth/legacy-state.js", () => ({ migrateLegacyState: fake.migrate }));

describe("loadConfig when config.json cannot be read", () => {
  let tmpHome: string;

  beforeEach(() => {
    vi.resetAllMocks();
    for (const key of Object.keys(process.env).filter((key) => key.startsWith("D2L_"))) vi.stubEnv(key, undefined);
    fake.password.mockResolvedValue("native-password");
    fake.migrate.mockResolvedValue({ tokenState: "absent", browserState: "encrypted" });

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-config-test-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("USERPROFILE", tmpHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("falls back to environment variables and logs a warning instead of crashing", async () => {
    const configDir = path.join(os.homedir(), ".brightspace-mcp");
    fs.mkdirSync(configDir, { recursive: true });
    const configFile = path.join(configDir, "config.json");
    fs.writeFileSync(configFile, "{ this is not valid json");

    vi.stubEnv("D2L_BASE_URL", "https://school.example");
    vi.stubEnv("D2L_USERNAME", "alice");

    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    const { loadConfig } = await import("../../src/utils/config.js");
    const config = await loadConfig();

    expect(config.baseUrl).toBe("https://school.example");
    expect(config.username).toBe("alice");
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`WARN.*${configFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    );

    warn.mockRestore();
  });
});
