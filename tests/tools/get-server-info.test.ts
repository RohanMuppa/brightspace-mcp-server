import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recordMicrosoftSession } from "../../src/auth/microsoft-session.js";
import { registerGetServerInfo } from "../../src/tools/get-server-info.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * get_server_info answers the first question of every support thread —
 * which version, which runtime, where is the config — without contacting
 * Brightspace and without revealing anything secret.
 */

const SESSION_DIR = path.join("/home/student", ".d2l-session", "accounts", "abc123");

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  baseUrl: "https://purdue.brightspace.com",
  sessionDir: SESSION_DIR,
  tokenTtl: 3600,
  headless: true,
  username: "student42",
  password: "hunter2-secret",
  courseFilter: { activeOnly: true },
  ...overrides,
});

function setup(appConfig: AppConfig, version = "9.8.7") {
  let name = "";
  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      name = n;
      handler = fn;
    },
  };
  registerGetServerInfo(server as any, appConfig, version);
  return { name: () => name, call: () => handler!({}) };
}

const payload = async (appConfig: AppConfig, version?: string) =>
  JSON.parse((await setup(appConfig, version).call()).content[0].text);

describe("get_server_info", () => {
  it("registers under the name get_server_info", () => {
    expect(setup(config()).name()).toBe("get_server_info");
  });

  it("returns exactly the documented fields", async () => {
    expect(Object.keys(await payload(config())).sort()).toEqual(
      ["arch", "configPath", "hasStoredCredential", "node", "platform", "schoolUrl", "sessionStatePath", "version"],
    );
  });

  it("reports the version the server was started with", async () => {
    expect((await payload(config(), "9.8.7")).version).toBe("9.8.7");
  });

  it("reports the running Node version, platform, and architecture", async () => {
    const info = await payload(config());
    expect([info.node, info.platform, info.arch]).toEqual([process.version, process.platform, process.arch]);
  });

  it("reports the config file under ~/.brightspace-mcp", async () => {
    expect((await payload(config())).configPath).toBe(path.join(os.homedir(), ".brightspace-mcp", "config.json"));
  });

  it("reports the resolved session state directory", async () => {
    expect((await payload(config())).sessionStatePath).toBe(SESSION_DIR);
  });

  it("reports the configured school origin", async () => {
    expect((await payload(config())).schoolUrl).toBe("https://purdue.brightspace.com");
  });

  it("reports a stored credential as true when one was found", async () => {
    expect((await payload(config())).hasStoredCredential).toBe(true);
  });

  it("reports a stored credential as false when none was found", async () => {
    expect((await payload(config({ password: undefined }))).hasStoredCredential).toBe(false);
  });

  it("never includes the password or the username anywhere in the output", async () => {
    const text = (await setup(config()).call()).content.map((c: any) => c.text).join("\n");
    expect(text).not.toMatch(/hunter2-secret|student42/);
  });

  it("carries no credential, token, cookie, or username field", async () => {
    const keys = Object.keys(await payload(config())).join(" ");
    expect(keys).not.toMatch(/password|token|cookie|username|secret/i);
  });
});

describe("get_server_info microsoftSession", () => {
  let dir: string;
  const persistent = {
    name: "ESTSAUTHPERSISTENT", value: "entra-cookie-secret", domain: ".login.microsoftonline.com", path: "/",
    expires: Date.parse("2099-01-01T00:00:00Z") / 1000, httpOnly: true, secure: true, sameSite: "None" as const,
  };
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "server-info-test-"));
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function savedSession() {
    await fs.writeFile(path.join(dir, "storage-state.encrypted.json"), "{}");
    await recordMicrosoftSession(dir, { cookies: [persistent], origins: [] }, { outcome: "ticked", at: "2026-10-01T12:00:00.000Z" });
  }

  it("reports what Microsoft remembered from the saved browser state", async () => {
    await savedSession();
    expect((await payload(config({ sessionDir: dir }))).microsoftSession).toEqual({
      staySignedIn: true,
      staySignedInExpires: "2099-01-01T00:00:00.000Z",
      rememberMfa: "ticked",
      rememberMfaAt: "2026-10-01T12:00:00.000Z",
    });
  });

  it("omits microsoftSession when no browser state is saved", async () => {
    expect(await payload(config({ sessionDir: dir }))).not.toHaveProperty("microsoftSession");
  });

  it("never includes an Entra cookie value", async () => {
    await savedSession();
    const text = (await setup(config({ sessionDir: dir })).call()).content.map((c: any) => c.text).join("\n");
    expect(text).not.toContain("entra-cookie-secret");
  });
});
