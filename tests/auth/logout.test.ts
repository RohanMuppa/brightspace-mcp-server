import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireProcessLock, AuthenticationInProgressError, lockOps } from "../../src/auth/auth-lock.js";
import { authLockPath } from "../../src/auth/mfa-challenge.js";
import { BrowserStateStore } from "../../src/auth/browser-state-store.js";
import { getStoredPassword, setStoredPassword } from "../../src/auth/credential-store.js";
import { clearSavedSession, runLogout } from "../../src/auth/logout.js";
import { recordMicrosoftSession } from "../../src/auth/microsoft-session.js";
import { SessionStore } from "../../src/auth/session-store.js";
import { accountSessionDirectory } from "../../src/utils/config.js";
import { MemoryCredentialBackend, testBrowserState, testToken } from "./secure-store-fixtures.js";

const SESSION_FILES = ["session.json", "storage-state.encrypted.json", "microsoft-session.json"];
/** Every file a version 1 install can leave behind, in the order logout reports them. */
const ALL_FILES = ["session.json", "storage-state.encrypted.json", "storage-state.json", "microsoft-session.json"];
const BASE_URL = "https://school.example";

async function names(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

describe("clearSavedSession", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "logout-test-")); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seed(dir: string, files = ALL_FILES): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    for (const name of files) await fs.writeFile(path.join(dir, name), `${name} contents`);
  }

  it("removes the session files from the account subdirectory when a username is configured", async () => {
    const dir = accountSessionDirectory(root, BASE_URL, "alice");
    const other = accountSessionDirectory(root, BASE_URL, "bob");
    await seed(dir, SESSION_FILES);
    await seed(other, SESSION_FILES);
    await seed(root, SESSION_FILES);

    const result = await clearSavedSession(dir);

    expect(result.removed).toEqual(SESSION_FILES);
    expect(await names(dir)).toEqual([]);
    // Another account's state, and the pre-account state in the root, are not this account's session.
    expect(await names(other)).toEqual([...SESSION_FILES].sort());
    expect(await names(root)).toEqual(["accounts", ...SESSION_FILES].sort());
  });

  it("removes the session files from the root when no username is configured, leaving accounts alone", async () => {
    const account = accountSessionDirectory(root, BASE_URL, "alice");
    await seed(root, SESSION_FILES);
    await seed(account, SESSION_FILES);

    const result = await clearSavedSession(accountSessionDirectory(root, BASE_URL, undefined));

    expect(result.removed).toEqual(SESSION_FILES);
    expect(await names(root)).toEqual(["accounts"]);
    expect(await names(account)).toEqual([...SESSION_FILES].sort());
  });

  it("also removes plaintext browser state left by a version 1 install, which would otherwise be re-adopted", async () => {
    await seed(root);
    expect((await clearSavedSession(root)).removed).toEqual(ALL_FILES);
    expect(await names(root)).toEqual([]);
  });

  it("removes only the files that exist and reports just those", async () => {
    await seed(root, ["session.json"]);
    expect((await clearSavedSession(root)).removed).toEqual(["session.json"]);
  });

  it("leaves files it does not own, such as the cooldown record and the dev activity log", async () => {
    await seed(root, [...SESSION_FILES, "auth-status.json", "salt"]);
    await fs.mkdir(path.join(root, "dev-activity"));
    await clearSavedSession(root);
    expect(await names(root)).toEqual(["auth-status.json", "dev-activity", "salt"]);
  });

  it("is idempotent: a second run finds nothing and changes nothing", async () => {
    await seed(root);
    await clearSavedSession(root);
    expect(await clearSavedSession(root)).toEqual({ removed: [] });
    expect(await names(root)).toEqual([]);
  });

  it("reports nothing to clear for an empty directory without leaving a lock behind", async () => {
    expect(await clearSavedSession(root)).toEqual({ removed: [] });
    expect(await names(root)).toEqual([]);
  });

  it("does not create a session directory that does not exist", async () => {
    const dir = accountSessionDirectory(root, BASE_URL, "alice");
    expect(await clearSavedSession(dir)).toEqual({ removed: [] });
    expect(await exists(dir)).toBe(false);
    expect(await exists(path.join(root, "accounts"))).toBe(false);
  });

  it("leaves no lock directory behind after removing files", async () => {
    await seed(root);
    await clearSavedSession(root);
    expect(await names(root)).toEqual([]);
  });

  describe("when a sign-in is in progress", () => {
    it("refuses and deletes nothing while an explicit sign-in holds the lock", async () => {
      await seed(root);
      const release = await acquireProcessLock(authLockPath(root));
      try {
        await expect(clearSavedSession(root)).rejects.toBeInstanceOf(AuthenticationInProgressError);
        expect(await names(root)).toEqual([".auth.lock", ...ALL_FILES].sort());
      } finally {
        await release();
      }
    });

    it("refuses without signaling a background sign-in, which an explicit auth run would have taken over", async () => {
      await seed(root);
      const kill = vi.spyOn(lockOps, "kill").mockImplementation(() => {});
      const release = await acquireProcessLock(authLockPath(root), { mode: "automatic" });
      try {
        await expect(clearSavedSession(root)).rejects.toBeInstanceOf(AuthenticationInProgressError);
        expect(kill).not.toHaveBeenCalled();
        expect(await names(root)).toEqual([".auth.lock", ...ALL_FILES].sort());
      } finally {
        await release();
      }
    });

    it("holds a lock that an explicit auth run cannot take over while it deletes", async () => {
      const kill = vi.spyOn(lockOps, "kill").mockImplementation(() => {});
      const release = await acquireProcessLock(authLockPath(root), { mode: "exclusive" });
      try {
        // An explicit run may take over a live *automatic* owner, never this one.
        await expect(acquireProcessLock(authLockPath(root))).rejects.toBeInstanceOf(AuthenticationInProgressError);
        expect(kill).not.toHaveBeenCalled();
      } finally {
        await release();
      }
      expect(await names(root)).toEqual([]);
    });

    it("proceeds when the lock was left behind by a process that no longer exists", async () => {
      await seed(root);
      const lock = authLockPath(root);
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 2_147_483_000, host: "gone", nonce: "stale", mode: "explicit" }));
      vi.spyOn(lockOps, "isDead").mockImplementation((owner) => owner.pid === 2_147_483_000);
      expect((await clearSavedSession(root)).removed).toEqual(ALL_FILES);
    });

    it("waits for a session write in flight instead of racing it", async () => {
      await seed(root);
      const release = await acquireProcessLock(path.join(root, ".session-write.lock"));
      const cleared = clearSavedSession(root);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await exists(path.join(root, "session.json"))).toBe(true);
      await release();
      expect((await cleared).removed).toContain("session.json");
      expect(await names(root)).toEqual([]);
    });
  });

  describe("with real encrypted state", () => {
    it("removes the session without touching the saved password, the encryption key, or config.json", async () => {
      const dir = accountSessionDirectory(root, BASE_URL, "alice");
      const home = path.join(root, "home", ".brightspace-mcp");
      await fs.mkdir(home, { recursive: true });
      const config = JSON.stringify({ baseUrl: BASE_URL, username: "alice", headless: true });
      await fs.writeFile(path.join(home, "config.json"), config);

      const backend = new MemoryCredentialBackend();
      await setStoredPassword(BASE_URL, "alice", "dummy-saved-password", backend);
      await new SessionStore(dir, { backend }).save(testToken);
      const browserState = new BrowserStateStore(dir, { backend });
      await browserState.save(testBrowserState);
      await recordMicrosoftSession(dir, testBrowserState, { outcome: "ticked", at: "2026-10-01T00:00:00.000Z" });
      const credentialsBefore = [...backend.values];
      const writesBefore = backend.writes;
      expect(credentialsBefore).toHaveLength(2);

      const result = await clearSavedSession(dir);

      expect(result.removed).toEqual(SESSION_FILES);
      expect(await new SessionStore(dir, { backend }).load()).toBeNull();
      expect(await browserState.load()).toBeUndefined();
      expect([...backend.values]).toEqual(credentialsBefore);
      expect(backend.writes).toBe(writesBefore);
      expect(await getStoredPassword(BASE_URL, "alice", backend)).toBe("dummy-saved-password");
      expect(await fs.readFile(path.join(home, "config.json"), "utf8")).toBe(config);

      // The next sign-in saves a new session under the same key rather than minting another.
      await new SessionStore(dir, { backend }).save(testToken);
      expect(backend.writes).toBe(writesBefore);
      expect(await new SessionStore(dir, { backend }).load()).toEqual(testToken);
    });
  });
});

describe("runLogout", () => {
  let dir: string;
  let lines: string[];
  const print = (line: string) => { lines.push(line); };
  const output = () => lines.join("\n");

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "logout-run-test-"));
    lines = [];
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("names each removed file, says what was kept, and warns about a running server", async () => {
    await fs.writeFile(path.join(dir, "session.json"), "x");
    await fs.writeFile(path.join(dir, "storage-state.encrypted.json"), "x");

    expect(await runLogout({ sessionDir: dir, print })).toBe(0);

    expect(output()).toContain("session.json");
    expect(output()).toContain("storage-state.encrypted.json");
    expect(output()).not.toContain("microsoft-session.json");
    expect(output()).toMatch(/saved password/i);
    expect(output()).toContain("config.json");
    expect(output()).toMatch(/authenticator/i);
    expect(output()).toMatch(/still hold an access token in memory/i);
    expect(output()).toMatch(/restart your AI client/i);
    expect(output()).toMatch(/not sign you out of Microsoft or Brightspace/i);
    expect(output()).toContain("npx -y brightspace-mcp-server@latest auth");
    // Names only, never a path.
    expect(output()).not.toContain(dir);
  });

  it("says there is nothing to clear and exits 0", async () => {
    expect(await runLogout({ sessionDir: dir, print })).toBe(0);
    expect(output()).toMatch(/nothing to clear/i);
    expect(output()).toMatch(/still hold an access token in memory/i);
    expect(output()).not.toMatch(/removed/i);
  });

  it("refuses with a clear message and exit code 2 while a sign-in is in progress", async () => {
    await fs.writeFile(path.join(dir, "session.json"), "x");
    const release = await acquireProcessLock(authLockPath(dir));
    try {
      expect(await runLogout({ sessionDir: dir, print })).toBe(2);
    } finally {
      await release();
    }
    expect(output()).toMatch(/sign-in is in progress/i);
    expect(output()).toMatch(/nothing was deleted/i);
    expect(await exists(path.join(dir, "session.json"))).toBe(true);
  });

  it("exits 1 and names the file when a removal fails", async () => {
    // A directory where a file belongs cannot be unlinked.
    await fs.mkdir(path.join(dir, "storage-state.encrypted.json"));
    await fs.writeFile(path.join(dir, "session.json"), "x");

    expect(await runLogout({ sessionDir: dir, print })).toBe(1);

    expect(output()).toContain("storage-state.encrypted.json");
    expect(output()).toMatch(/run .* again/i);
  });
});
