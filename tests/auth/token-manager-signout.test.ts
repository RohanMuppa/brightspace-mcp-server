import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TokenManager } from "../../src/auth/token-manager.js";
import { SessionStore, SESSION_FILE } from "../../src/auth/session-store.js";
import { TokenRefreshError } from "../../src/api/errors.js";
import type { TokenData } from "../../src/types/index.js";
import type { mintAccessToken } from "../../src/auth/token-mint.js";
import { MemoryCredentialBackend, retireTestFile } from "./secure-store-fixtures.js";

type MintFn = typeof mintAccessToken;

const BASE_URL = "https://purdue.brightspace.com";

const tokenNamed = (accessToken: string, extra: Partial<TokenData> = {}): TokenData => ({
  accessToken,
  tenantOrigin: BASE_URL,
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser",
  ...extra,
});

const alice = (accessToken: string, extra: Partial<TokenData> = {}) =>
  tokenNamed(accessToken, { uniqueName: "alice@purdue.edu", cookieHeader: `d2lSessionVal=${accessToken}`, csrfToken: "xsrf", ...extra });

/** A path no operating system can stat: Node rejects the NUL byte before any syscall. */
const unstattablePath = (dir: string) => path.join(dir, "bad\0dir");

/** An injectable store whose every method is a stub, so a test can count calls. */
const stubStore = (overrides: Record<string, unknown> = {}) => ({
  load: vi.fn(async () => null as TokenData | null),
  save: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
  saveIfCurrent: vi.fn(async () => true),
  clearIfCurrent: vi.fn(async () => true),
  ...overrides,
}) as any;

/**
 * Several servers share one saved session. Once `brightspace-auth --logout`
 * (or a sign_out tool call) deletes session.json, a server that is already
 * running must stop using what it remembers, within its next call.
 */
describe("TokenManager notices a deleted or replaced saved session", () => {
  let dir: string;
  let backend: MemoryCredentialBackend;
  let other: SessionStore;
  let sessionPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "token-manager-signout-"));
    sessionPath = path.join(dir, SESSION_FILE);
    backend = new MemoryCredentialBackend();
    other = new SessionStore(dir, { backend, trash: retireTestFile });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A server process: its own TokenManager over the shared directory. */
  const startServer = (extra: Record<string, unknown> = {}) =>
    new TokenManager({ baseUrl: BASE_URL, sessionStore: new SessionStore(dir, { backend, trash: retireTestFile }), ...extra });

  it("returns the cached token while the saved session still exists", async () => {
    const server = startServer();
    await server.setToken(tokenNamed("old-token-12345678"));

    expect((await server.getToken())?.accessToken).toBe("old-token-12345678");
    expect(await server.sessionChanged()).toBe(false);
  });

  it("returns null after another process deletes session.json, then picks up a new sign-in", async () => {
    const server = startServer();
    await server.setToken(tokenNamed("old-token-12345678"));
    expect((await server.getToken())?.accessToken).toBe("old-token-12345678");

    await fs.unlink(sessionPath); // what logout does, from another process

    expect(await server.getToken()).toBeNull();
    expect(await server.getToken()).toBeNull();

    await other.save(tokenNamed("new-token-87654321"));
    expect((await server.getToken())?.accessToken).toBe("new-token-87654321");
  });

  it("does not hand back a token it had already seen rejected once the session is gone and rewritten", async () => {
    const server = startServer();
    await server.setToken(tokenNamed("old-token-12345678"));
    await server.getToken("old-token-12345678");
    await fs.unlink(sessionPath);
    expect(await server.getToken()).toBeNull();

    // The same token text signed in again is a fresh sign-in, not the rejected one.
    await other.save(tokenNamed("old-token-12345678"));
    expect((await server.getToken())?.accessToken).toBe("old-token-12345678");
  });

  it("forgets a rejection even when nothing is cached (the rejected-token half of the guard)", async () => {
    const server = startServer();
    await other.save(tokenNamed("same-text-12345678"));

    // Rejected on first sight: nothing usable, nothing cached.
    expect(await server.getToken("same-text-12345678")).toBeNull();
    expect((server as any).cachedToken).toBeNull();

    await fs.unlink(sessionPath);
    expect(await server.getToken()).toBeNull();

    // The identical text saved again is a new sign-in; the rejection died with the old file.
    await other.save(tokenNamed("same-text-12345678"));
    expect((await server.getToken())?.accessToken).toBe("same-text-12345678");
  });

  it("forgets a rejection reported while no session file existed, once that is noticed", async () => {
    const server = startServer();
    expect(await server.getToken("same-text-12345678")).toBeNull(); // nothing saved, nothing cached
    expect(await server.getToken()).toBeNull();

    await other.save(tokenNamed("same-text-12345678"));
    expect((await server.getToken())?.accessToken).toBe("same-text-12345678");
  });

  it("keeps a rejection while the saved session is unchanged", async () => {
    const server = startServer();
    await other.save(tokenNamed("same-text-12345678"));
    expect(await server.getToken("same-text-12345678")).toBeNull();
    expect(await server.getToken()).toBeNull();
  });

  describe("sessionChanged()", () => {
    it("is true once the file is gone, and false after the loss has been reported", async () => {
      const server = startServer();
      await server.setToken(tokenNamed("old-token-12345678"));
      await fs.unlink(sessionPath);

      expect(await server.sessionChanged()).toBe(true);
      await other.save(tokenNamed("new-token-87654321"));
      expect(await server.sessionChanged()).toBe(false);
    });

    it("is true when the file was deleted and recreated by a different account before the next request", async () => {
      const server = startServer();
      await server.setToken(alice("alice-token-12345678"));
      expect((await server.getToken())?.accessToken).toBe("alice-token-12345678");

      await fs.unlink(sessionPath);
      await other.save(alice("bob-token-12345678", { uniqueName: "bob@purdue.edu", cookieHeader: "d2lSessionVal=bob" }));

      expect(await server.sessionChanged()).toBe(true);
      // And the new account's token is what is served from now on.
      expect((await server.getToken())?.accessToken).toBe("bob-token-12345678");
      expect(await server.sessionChanged()).toBe(false);
    });

    it("getToken adopts a different account's token written over the file, and reports the change once", async () => {
      const server = startServer();
      await server.setToken(alice("alice-token-12345678"));

      await fs.unlink(sessionPath);
      await other.save(alice("bob-token-12345678", { uniqueName: "bob@purdue.edu", cookieHeader: "d2lSessionVal=bob" }));

      // The first thing to notice is getToken, not the client's cache check.
      expect((await server.getToken())?.accessToken).toBe("bob-token-12345678");
      expect(await server.sessionChanged()).toBe(true);
      expect(await server.sessionChanged()).toBe(false);
    });

    it("is false when another process re-minted the same account's token (hourly refresh)", async () => {
      const server = startServer();
      await server.setToken(alice("alice-token-12345678"));

      await other.save(alice("alice-reminted-1234567", { cookieHeader: "d2lSessionVal=alice-new-cookie" }));

      expect(await server.sessionChanged()).toBe(false);
      // The re-minted token is the one served now.
      expect((await server.getToken())?.accessToken).toBe("alice-reminted-1234567");
      expect(await server.sessionChanged()).toBe(false);
    });

    it("falls back to the cookie when no name was captured: same cookie is the same account", async () => {
      const server = startServer();
      await server.setToken(tokenNamed("first-token-12345678", { cookieHeader: "d2lSessionVal=c1", csrfToken: "x" }));
      await other.save(tokenNamed("second-token-1234567", { cookieHeader: "d2lSessionVal=c1", csrfToken: "x" }));
      expect(await server.sessionChanged()).toBe(false);

      await other.save(tokenNamed("third-token-12345678", { cookieHeader: "d2lSessionVal=c2", csrfToken: "x" }));
      expect(await server.sessionChanged()).toBe(true);
    });

    it("clears when it cannot tell: no name and no cookie on either side", async () => {
      const server = startServer();
      await server.setToken(tokenNamed("first-token-12345678"));
      await other.save(tokenNamed("second-token-1234567"));
      expect(await server.sessionChanged()).toBe(true);
    });

    it("clears when a name is known on only one side", async () => {
      const server = startServer();
      await server.setToken(alice("alice-token-12345678"));
      await other.save(tokenNamed("nameless-token-1234", { cookieHeader: "d2lSessionVal=other" }));
      expect(await server.sessionChanged()).toBe(true);
    });

    it("matches names regardless of case", async () => {
      const server = startServer();
      await server.setToken(alice("alice-token-12345678"));
      await other.save(alice("alice-again-12345678", { uniqueName: "Alice@Purdue.edu", cookieHeader: "d2lSessionVal=zzz" }));
      expect(await server.sessionChanged()).toBe(false);
    });

    it("is true when the same account's session moved to another tenant", async () => {
      const server = startServer();
      await server.setToken(alice("alice-token-12345678"));
      await other.save(alice("alice-other-tenant-1", { tenantOrigin: "https://other.brightspace.com" }));
      expect(await server.sessionChanged()).toBe(true);
    });

    it("is true when the replacement session is not usable yet (expired), so the old cache is not trusted", async () => {
      // The expired token carries a cookie, so getToken tries a mint; stub it
      // with what a live tenant says for a dead cookie, so the test stays offline.
      const mint = vi.fn<MintFn>(async () => ({ ok: false, reason: "sessionExpired" }) as const);
      const server = startServer({ mint });
      await server.setToken(alice("alice-token-12345678"));
      await fs.unlink(sessionPath);
      await other.save(alice("bob-expired-1234567", { uniqueName: "bob@purdue.edu", cookieHeader: "d2lSessionVal=bob", expiresAt: Date.now() - 1000 }));

      expect(await server.sessionChanged()).toBe(true);
      expect(await server.getToken()).toBeNull();
      expect(mint).toHaveBeenCalledTimes(1);
    });

    it("never touches the disk on a cold start", async () => {
      const store = stubStore({ fingerprint: vi.fn(async () => "x") });
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });

      expect(await server.sessionChanged()).toBe(false);
      expect(store.fingerprint).not.toHaveBeenCalled();
      expect(store.load).not.toHaveBeenCalled();
    });
  });

  describe("forgetSession()", () => {
    it("drops the cached token synchronously and touches no files", async () => {
      const store = stubStore({ fingerprint: vi.fn(async () => "fp-1") });
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await server.setToken(tokenNamed("old-token-12345678"));
      store.save.mockClear();
      store.fingerprint.mockClear();

      server.forgetSession();

      expect((server as any).cachedToken).toBeNull();
      expect(store.load).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      expect(store.clear).not.toHaveBeenCalled();
      expect(store.fingerprint).not.toHaveBeenCalled();
    });

    it("drops the token even when a re-sign-in has already recreated the file", async () => {
      const own = new SessionStore(dir, { backend, trash: retireTestFile });
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: own });
      await server.setToken(alice("alice-token-12345678"));
      await fs.unlink(sessionPath);
      await other.save(alice("alice-token-12345678", { capturedAt: Date.now() })); // someone signs in again

      server.forgetSession();

      expect((server as any).cachedToken).toBeNull();
      expect(await server.sessionChanged()).toBe(true);
      // The next call reads the recreated file rather than serving memory.
      const load = vi.spyOn(own, "load");
      expect((await server.getToken())?.accessToken).toBe("alice-token-12345678");
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("forgets a remembered rejection", async () => {
      const server = startServer();
      await other.save(tokenNamed("same-text-12345678"));
      expect(await server.getToken("same-text-12345678")).toBeNull();

      server.forgetSession();

      expect((await server.getToken())?.accessToken).toBe("same-text-12345678");
    });
  });

  it("checks with a stat, never a decrypting load, on the cached hot path", async () => {
    const injected = new SessionStore(dir, { backend, trash: retireTestFile });
    const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: injected });
    await server.setToken(tokenNamed("old-token-12345678"));
    const load = vi.spyOn(injected, "load");
    const peek = vi.spyOn(injected, "peek");

    for (let i = 0; i < 5; i++) await server.getToken();
    await server.sessionChanged();

    expect(load).not.toHaveBeenCalled();
    expect(peek).not.toHaveBeenCalled();
  });

  it("does not stat at all on a cold start whose load finds nothing", async () => {
    const store = stubStore({ fingerprint: vi.fn(async () => null) });
    const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });

    expect(await server.getToken()).toBeNull();
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.fingerprint).not.toHaveBeenCalled();
  });

  describe("when the file's state cannot be determined", () => {
    it("does not sign the user out when the stat fails for a reason other than a missing file", async () => {
      const hybrid = stubStore({ fingerprint: () => new SessionStore(unstattablePath(dir), { backend }).fingerprint() });
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: hybrid });
      await server.setToken(tokenNamed("old-token-12345678"));

      expect((await server.getToken())?.accessToken).toBe("old-token-12345678");
      expect(await server.sessionChanged()).toBe(false);
      expect(hybrid.load).not.toHaveBeenCalled();
    });

    it("keeps the cached token when the injected store cannot report a fingerprint at all", async () => {
      const store = stubStore();
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await server.setToken(tokenNamed("old-token-12345678"));

      expect((await server.getToken())?.accessToken).toBe("old-token-12345678");
      expect(await server.sessionChanged()).toBe(false);
    });

    it("keeps the cached token, and says the session changed, when the replaced file cannot be read", async () => {
      let fp = "fp-1";
      const store = stubStore({ fingerprint: vi.fn(async () => fp) });
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await server.setToken(alice("alice-token-12345678"));

      fp = "fp-2";
      store.load.mockRejectedValue(new Error("credential store locked"));

      expect(await server.sessionChanged()).toBe(true);
      expect((await server.getToken())?.accessToken).toBe("alice-token-12345678");
    });
  });

  describe("an injected store", () => {
    it("signs the manager out when the store reports the file missing", async () => {
      let fp: string | null = "fp-1";
      const store = stubStore({ fingerprint: vi.fn(async () => fp) });
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await server.setToken(tokenNamed("old-token-12345678"));
      expect((await server.getToken())?.accessToken).toBe("old-token-12345678");

      fp = null;
      expect(await server.getToken()).toBeNull();
    });

    it("reloads from the store when the fingerprint changes, and not otherwise", async () => {
      let fp = "fp-1";
      const store = stubStore({ fingerprint: vi.fn(async () => fp) });
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await server.setToken(alice("alice-token-12345678"));

      await server.getToken();
      await server.getToken();
      expect(store.load).not.toHaveBeenCalled();

      fp = "fp-2";
      store.load.mockResolvedValue(alice("alice-reminted-1234567"));
      expect((await server.getToken())?.accessToken).toBe("alice-reminted-1234567");
      expect(store.load).toHaveBeenCalledTimes(1);

      await server.getToken(); // fingerprint recorded; no further reload
      expect(store.load).toHaveBeenCalledTimes(1);
    });

    it("treats a file that vanished between the stat and the reload as signed out", async () => {
      let fp = "fp-1";
      const store = stubStore({ fingerprint: vi.fn(async () => fp) });
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: store });
      await server.setToken(alice("alice-token-12345678"));

      fp = "fp-2";
      store.load.mockResolvedValue(null);

      expect(await server.getToken()).toBeNull();
      expect(await server.sessionChanged()).toBe(true);
    });
  });

  describe("a signed-out session while a mint is in flight", () => {
    const expiredWithCookies = (): TokenData => ({
      ...alice("expired-token-123456"),
      expiresAt: Date.now() - 1000,
    });

    it("returns null, not a refresh error, when the file is deleted during the mint", async () => {
      const mint = vi.fn<MintFn>(async () => {
        await fs.unlink(sessionPath);
        return { ok: true, accessToken: "fresh-jwt" } as const;
      });
      const server = startServer({ mint });
      await server.setToken(expiredWithCookies());

      expect(await server.getToken()).toBeNull();
      expect(mint).toHaveBeenCalledTimes(1);
      expect(await fs.stat(sessionPath).catch(() => null)).toBeNull(); // not resurrected
    });

    it("returns null when the file is deleted during a mint that reports the cookie expired", async () => {
      const mint = vi.fn<MintFn>(async () => {
        await fs.unlink(sessionPath);
        return { ok: false, reason: "sessionExpired" } as const;
      });
      const server = startServer({ mint });
      await server.setToken(expiredWithCookies());

      expect(await server.getToken()).toBeNull();
    });

    it("returns null when the file disappears between the post-mint read and the save", async () => {
      const stale = expiredWithCookies();
      const store = stubStore({
        saveIfCurrent: vi.fn(async () => false),
      });
      store.load.mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockResolvedValue(null);
      const mint = vi.fn<MintFn>(async () => ({ ok: true, accessToken: "fresh-jwt" }) as const);
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: store, mint });

      expect(await server.getToken()).toBeNull();
    });

    it("still reports a refresh error when the replacement exists but cannot be used", async () => {
      const stale = expiredWithCookies();
      const unusable = { ...stale, accessToken: "replaced-expired-12", capturedAt: stale.capturedAt + 1 };
      const store = stubStore({ saveIfCurrent: vi.fn(async () => false) });
      store.load.mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockResolvedValue(unusable);
      const mint = vi.fn<MintFn>(async () => ({ ok: true, accessToken: "fresh-jwt" }) as const);
      const server = new TokenManager({ baseUrl: BASE_URL, sessionStore: store, mint });

      await expect(server.getToken()).rejects.toBeInstanceOf(TokenRefreshError);
    });
  });

  describe("env credentials have no saved session", () => {
    it("D2L_ACCESS_TOKEN keeps working with no session.json, and is never reported changed", async () => {
      const fingerprint = vi.fn(async () => null);
      const server = new TokenManager({
        baseUrl: BASE_URL,
        envAccessToken: "env-admin-token",
        sessionStore: stubStore({ fingerprint }),
      });

      expect((await server.getToken())?.accessToken).toBe("env-admin-token");
      expect(await server.sessionChanged()).toBe(false);
      expect(fingerprint).not.toHaveBeenCalled();
    });

    it("D2L_SESSION_COOKIE keeps working with no session.json", async () => {
      const server = new TokenManager({ sessionDir: dir, baseUrl: BASE_URL, envSessionCookie: "d2lSessionVal=a; d2lSecureSessionVal=b" });

      expect((await server.getToken())?.accessToken).toBe("cookie:d2lSessionVal=a; d2lSecureSessionVal=b");
      expect(await server.sessionChanged()).toBe(false);
    });
  });
});

describe("SessionStore.fingerprint", () => {
  let dir: string;
  let backend: MemoryCredentialBackend;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-fingerprint-"));
    backend = new MemoryCredentialBackend();
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("is null when session.json does not exist, and a string once it does, without reading it", async () => {
    const store = new SessionStore(dir, { backend });
    expect(await store.fingerprint()).toBeNull();
    await fs.writeFile(path.join(dir, SESSION_FILE), "not even json");
    expect(typeof await store.fingerprint()).toBe("string");
  });

  it("is stable while the file is untouched and changes when it is rewritten", async () => {
    const store = new SessionStore(dir, { backend, trash: retireTestFile });
    await store.save(tokenNamed("first-token-12345678"));
    const first = await store.fingerprint();
    expect(await store.fingerprint()).toBe(first);

    await store.save(tokenNamed("second-token-with-a-longer-text-1234567890"));
    const second = await store.fingerprint();
    expect(second).not.toBe(first);
  });

  it("changes when the file is deleted and recreated with the same contents", async () => {
    const file = path.join(dir, SESSION_FILE);
    const store = new SessionStore(dir, { backend });
    await fs.writeFile(file, "same bytes");
    const first = await store.fingerprint();
    await fs.unlink(file);
    expect(await store.fingerprint()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(file, "same bytes");
    expect(await store.fingerprint()).not.toBe(first);
  });

  it("is undefined, not null, when the check fails for another reason", async () => {
    expect(await new SessionStore(unstattablePath(dir), { backend }).fingerprint()).toBeUndefined();
  });

  it("is null when the whole session directory is gone", async () => {
    const store = new SessionStore(path.join(dir, "never-created"), { backend });
    expect(await store.fingerprint()).toBeNull();
  });
});
