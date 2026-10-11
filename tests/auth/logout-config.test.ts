import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const fake = vi.hoisted(() => ({
  password: vi.fn(), migrate: vi.fn(), save: vi.fn(),
  store: null as Record<string, unknown> | null,
}));
vi.mock("../../src/utils/config-store.js", () => ({
  configStoreExists: () => fake.store !== null,
  loadConfigStore: () => fake.store,
  saveConfigStore: fake.save,
  getConfigStorePath: () => "/fake/config.json",
}));
vi.mock("../../src/utils/secure-config.js", () => ({ resolveStoredPassword: fake.password }));
vi.mock("../../src/auth/legacy-state.js", () => ({ migrateLegacyState: fake.migrate }));
import { runLogout } from "../../src/auth/logout.js";
import { accountSessionDirectory } from "../../src/utils/config.js";

describe("brightspace-auth --logout resolves the session directory the way sign-in does", () => {
  let root: string;
  const lines: string[] = [];
  const print = (line: string) => { lines.push(line); };

  async function seed(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "session.json"), "x");
    await fs.writeFile(path.join(dir, "storage-state.encrypted.json"), "x");
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    lines.length = 0;
    for (const key of Object.keys(process.env).filter((key) => key.startsWith("D2L_"))) vi.stubEnv(key, undefined);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "logout-config-test-"));
    fake.store = null;
    fake.password.mockResolvedValue("native-password");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("clears the account subdirectory for the configured username, and nothing else", async () => {
    vi.stubEnv("D2L_SESSION_DIR", root);
    fake.store = { baseUrl: "https://school.example/ignored/path", username: "alice" };
    const account = accountSessionDirectory(root, "https://school.example", "alice");
    await seed(account);
    await seed(root);

    expect(await runLogout({ print })).toBe(0);

    expect(await fs.readdir(account)).toEqual([]);
    expect((await fs.readdir(root)).sort()).toEqual(["accounts", "session.json", "storage-state.encrypted.json"]);
  });

  it("lets the environment override the stored school, username and session directory", async () => {
    vi.stubEnv("D2L_SESSION_DIR", root);
    vi.stubEnv("D2L_BASE_URL", "https://other.example");
    vi.stubEnv("D2L_USERNAME", "carol");
    fake.store = { baseUrl: "https://school.example", username: "alice", sessionDir: path.join(root, "unused") };
    const carol = accountSessionDirectory(root, "https://other.example", "carol");
    const alice = accountSessionDirectory(root, "https://school.example", "alice");
    await seed(carol);
    await seed(alice);

    expect(await runLogout({ print })).toBe(0);

    expect(await fs.readdir(carol)).toEqual([]);
    expect((await fs.readdir(alice)).sort()).toEqual(["session.json", "storage-state.encrypted.json"]);
  });

  it("clears the root when no username is configured", async () => {
    vi.stubEnv("D2L_SESSION_DIR", root);
    await seed(root);
    expect(await runLogout({ print })).toBe(0);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("uses the session directory saved in config.json when the environment does not set one", async () => {
    fake.store = { sessionDir: root };
    await seed(root);
    expect(await runLogout({ print })).toBe(0);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("never reads or writes the saved password or config, and never migrates legacy state", async () => {
    vi.stubEnv("D2L_SESSION_DIR", root);
    fake.store = { baseUrl: "https://school.example", username: "alice" };
    await seed(accountSessionDirectory(root, "https://school.example", "alice"));

    await runLogout({ print });

    expect(fake.password).not.toHaveBeenCalled();
    expect(fake.migrate).not.toHaveBeenCalled();
    expect(fake.save).not.toHaveBeenCalled();
  });

  it("rejects a credential-bearing school URL the way sign-in does", async () => {
    vi.stubEnv("D2L_BASE_URL", "https://alice:secret@school.example");
    vi.stubEnv("D2L_SESSION_DIR", root);
    await seed(root);
    expect(await runLogout({ print })).toBe(1);
    expect(lines.join("\n")).toContain("without embedded credentials");
    expect(await fs.readdir(root)).toContain("session.json");
  });
});
