import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as realOs from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TokenData } from "../../src/types/index.js";

/**
 * The session key used to be derived from the machine hostname. On a campus
 * network os.hostname() is a DHCP reverse-DNS name, for example
 * pal-nat186-166-147.itap.purdue.edu, and it changes with the lease. When it
 * changed, the AES-GCM tag stopped verifying and the saved session became
 * permanently unreadable, which cost the user a full MFA login every time they
 * moved between networks.
 *
 * The key now derives from the username and the per-install random salt, both
 * of which are stable for the life of the install.
 */

let hostname = "host-at-save-time";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const patched = { ...actual, hostname: () => hostname };
  return { ...patched, default: patched };
});

const { SessionStore } = await import("../../src/auth/session-store.js");

const token = (): TokenData => ({
  accessToken: "bearer-jwt-value",
  capturedAt: 1_756_000_000_000,
  expiresAt: 1_756_003_600_000,
  source: "browser",
  cookieHeader: "d2lSessionVal=abc; d2lSecureSessionVal=def",
  csrfToken: "xsrf-token-value",
});

describe("session key stability", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(realOs.tmpdir(), "bmcp-session-"));
    hostname = "host-at-save-time";
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loads a session saved under a different hostname", async () => {
    hostname = "pal-nat186-166-147.itap.purdue.edu";
    await new SessionStore(dir).save(token());

    // The laptop moves to another network and DHCP renames it.
    hostname = "dhcp-10-186-99-4.dorm.purdue.edu";
    const loaded = await new SessionStore(dir).load();

    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe("bearer-jwt-value");
    expect(loaded!.cookieHeader).toContain("d2lSessionVal");
    expect(loaded!.csrfToken).toBe("xsrf-token-value");
  });

  it("loads when the hostname is not resolvable at all", async () => {
    await new SessionStore(dir).save(token());

    hostname = "";
    const loaded = await new SessionStore(dir).load();

    expect(loaded?.accessToken).toBe("bearer-jwt-value");
  });

  it("still round-trips normally", async () => {
    const store = new SessionStore(dir);
    const original = token();
    await store.save(original);

    expect(await store.load()).toEqual(original);
  });

  it("keeps the salt, so two installs derive different keys", async () => {
    const dirB = await fs.mkdtemp(path.join(realOs.tmpdir(), "bmcp-session-b-"));
    try {
      await new SessionStore(dir).save(token());
      await new SessionStore(dirB).save(token());

      const [a, b] = await Promise.all([
        fs.readFile(path.join(dir, "salt")),
        fs.readFile(path.join(dirB, "salt")),
      ]);
      expect(a.equals(b)).toBe(false);

      const cipherA = JSON.parse(await fs.readFile(path.join(dir, "session.json"), "utf-8"));
      const cipherB = JSON.parse(await fs.readFile(path.join(dirB, "session.json"), "utf-8"));
      expect(cipherA.encrypted.data).not.toBe(cipherB.encrypted.data);
    } finally {
      await fs.rm(dirB, { recursive: true, force: true });
    }
  });

  it("discards a session it cannot decrypt instead of failing forever", async () => {
    const store = new SessionStore(dir);
    await store.save(token());

    // Simulate a file written by the old hostname-keyed build: valid JSON,
    // valid structure, ciphertext this install can never authenticate.
    const file = path.join(dir, "session.json");
    const onDisk = JSON.parse(await fs.readFile(file, "utf-8"));
    onDisk.encrypted.data = onDisk.encrypted.data.replace(/^../, "ff");
    await fs.writeFile(file, JSON.stringify(onDisk));

    expect(await store.load()).toBeNull();

    // The unreadable file is gone, so the next start does a clean login
    // rather than warning about the same file on every single run.
    await expect(fs.access(file)).rejects.toThrow();
  });
});
