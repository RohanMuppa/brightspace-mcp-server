import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), del: vi.fn(), save: vi.fn(), load: vi.fn(), exists: vi.fn(),
  acquire: vi.fn(), release: vi.fn(), locked: false,
  current: null as Record<string, unknown> | null,
}));
vi.mock("../../src/auth/credential-store.js", () => ({
  getStoredPassword: fake.get,
  setStoredPassword: fake.set,
  deleteStoredPassword: fake.del,
}));
vi.mock("../../src/utils/config-store.js", () => ({
  saveConfigStore: fake.save, loadConfigStore: fake.load, configStoreExists: fake.exists,
  getConfigStorePath: () => "/dummy/config.json",
}));
vi.mock("../../src/auth/auth-lock.js", () => ({ acquireProcessLock: fake.acquire }));
import { resolveStoredPassword, saveSecureConfig } from "../../src/utils/secure-config.js";

describe("secure configuration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("D2L_PASSWORD", "");
    fake.current = null;
    fake.locked = false;
    fake.exists.mockImplementation(() => fake.current !== null);
    fake.load.mockImplementation(() => fake.current);
    fake.save.mockImplementation(config => { fake.current = structuredClone(config); });
    fake.release.mockImplementation(async () => { fake.locked = false; });
    fake.acquire.mockImplementation(async () => {
      if (fake.locked) throw new Error("Configuration write already in progress");
      fake.locked = true;
      return fake.release;
    });
  });

  it("writes only public config after verifying the native password", async () => {
    fake.get.mockResolvedValue("secret");
    await saveSecureConfig({ baseUrl: "https://school.example", username: "alice", password: "secret", campus: "Poly" });
    expect(fake.set).toHaveBeenCalledWith("https://school.example", "alice", "secret");
    expect(fake.save).toHaveBeenCalledWith({ baseUrl: "https://school.example", username: "alice", campus: "Poly" });
    expect(fake.set.mock.invocationCallOrder[0]).toBeLessThan(fake.save.mock.invocationCallOrder[0]);
  });

  it("removes any saved password when passwordless sign-in is chosen", async () => {
    await saveSecureConfig({ baseUrl: "https://school.example", username: "alice", passwordless: true });
    expect(fake.set).not.toHaveBeenCalled();
    expect(fake.del).toHaveBeenCalledWith("https://school.example", "alice");
    expect(fake.save).toHaveBeenCalledWith({ baseUrl: "https://school.example", username: "alice", passwordless: true });
  });

  it("preserves the old config if native storage fails", async () => {
    fake.set.mockRejectedValue(new Error("vault locked"));
    await expect(saveSecureConfig({ baseUrl: "https://school.example", username: "alice", password: "secret" })).rejects.toThrow("vault locked");
    expect(fake.save).not.toHaveBeenCalled();
  });

  it("never writes credentials embedded in a school URL", async () => {
    await expect(saveSecureConfig({ baseUrl: "https://alice:secret@school.example", username: "alice", password: "secret" }))
      .rejects.toThrow("without embedded credentials");
    expect(fake.set).not.toHaveBeenCalled();
    expect(fake.save).not.toHaveBeenCalled();
  });

  it("preserves the old config if verification fails", async () => {
    fake.get.mockResolvedValue(null);
    await expect(saveSecureConfig({ baseUrl: "https://school.example", username: "alice", password: "secret" })).rejects.toThrow("verify");
    expect(fake.save).not.toHaveBeenCalled();
  });

  it("migrates the original account before selecting an environment-overridden account", async () => {
    fake.get.mockImplementation(async (_base: string, username: string) => username === "alice" ? "old-secret" : "other-secret");
    fake.current = {
      baseUrl: "https://school.example", username: "alice", password: "old-secret",
    };
    const password = await resolveStoredPassword("https://other.example", "bob", fake.current);
    expect(fake.set).toHaveBeenCalledWith("https://school.example", "alice", "old-secret");
    expect(password).toBe("other-secret");
    expect(fake.save).toHaveBeenCalledWith({ baseUrl: "https://school.example", username: "alice" });
  });

  it("surfaces a locked vault instead of returning missing credentials", async () => {
    fake.get.mockRejectedValue(new Error("vault locked"));
    await expect(resolveStoredPassword("https://school.example", "alice", null)).rejects.toThrow("vault locked");
  });

  it("accepts environment input without copying it into a config file", async () => {
    vi.stubEnv("D2L_PASSWORD", "env-secret");
    fake.get.mockResolvedValue("env-secret");
    expect(await resolveStoredPassword("https://school.example", "alice", null)).toBe("env-secret");
    expect(fake.set).toHaveBeenCalledWith("https://school.example", "alice", "env-secret");
    expect(fake.save).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer setup with a stale migration snapshot", async () => {
    const stale = { baseUrl: "https://school.example", username: "alice", password: "old-secret", campus: "Old" };
    const latest = { baseUrl: "https://school.example", username: "alice", campus: "New" };
    fake.current = latest;
    fake.get.mockResolvedValue("new-secret");

    expect(await resolveStoredPassword("https://school.example", "alice", stale)).toBe("new-secret");
    expect(fake.set).not.toHaveBeenCalled();
    expect(fake.save).not.toHaveBeenCalled();
    expect(fake.current).toEqual(latest);
    expect(fake.acquire).toHaveBeenCalledWith(expect.stringContaining(".config-write.lock"));
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("migrates the latest legacy record instead of stale credentials and settings", async () => {
    const stale = { baseUrl: "https://school.example", username: "alice", password: "old-secret", campus: "Old" };
    fake.current = { ...stale, password: "latest-secret", campus: "New" };
    fake.get.mockResolvedValue("latest-secret");

    await resolveStoredPassword("https://school.example", "alice", stale);

    expect(fake.set).toHaveBeenCalledWith("https://school.example", "alice", "latest-secret");
    expect(fake.save).toHaveBeenCalledWith({ baseUrl: "https://school.example", username: "alice", campus: "New" });
    expect(fake.acquire).toHaveBeenCalledTimes(1);
  });

  it("does not recreate a config removed after the migration snapshot was read", async () => {
    fake.get.mockResolvedValue(null);
    await resolveStoredPassword("https://school.example", "alice", {
      baseUrl: "https://school.example", username: "alice", password: "old-secret",
    });
    expect(fake.save).not.toHaveBeenCalled();
    expect(fake.set).not.toHaveBeenCalled();
  });

  it("holds the writer lock through native persistence and rejects concurrent setup", async () => {
    let finishWrite!: () => void;
    let enteredWrite!: () => void;
    const entered = new Promise<void>(resolve => { enteredWrite = resolve; });
    fake.set.mockImplementation(async () => {
      enteredWrite();
      await new Promise<void>(resolve => { finishWrite = resolve; });
    });
    fake.get.mockResolvedValue("first-secret");
    const first = saveSecureConfig({ baseUrl: "https://school.example", username: "alice", password: "first-secret" });
    await entered;

    await expect(saveSecureConfig({ baseUrl: "https://school.example", username: "alice", password: "second-secret" }))
      .rejects.toThrow("write already in progress");
    expect(fake.set).toHaveBeenCalledTimes(1);
    expect(fake.save).not.toHaveBeenCalled();
    finishWrite();
    await first;
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.locked).toBe(false);
  });

  it("releases the config lock when native persistence fails", async () => {
    fake.set.mockRejectedValue(new Error("vault locked"));
    await expect(saveSecureConfig({ baseUrl: "https://school.example", username: "alice", password: "secret" }))
      .rejects.toThrow("vault locked");
    expect(fake.release).toHaveBeenCalledOnce();
    expect(fake.locked).toBe(false);
  });
});
