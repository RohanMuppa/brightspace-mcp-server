import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { fileURLToPath } from "node:url";
import { MemoryCredentialBackend, testToken } from "./secure-store-fixtures.js";

let hostname = "host-at-save-time";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, hostname: () => hostname };
});
const { SessionStore } = await import("../../src/auth/session-store.js");
const { getSessionEncryptionKey } = await import("../../src/auth/credential-store.js");

describe("native session key stability", () => {
  let dir: string;
  let backend: MemoryCredentialBackend;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-key-test-"));
    backend = new MemoryCredentialBackend();
    hostname = "host-at-save-time";
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("loads after a DHCP hostname change", async () => {
    await new SessionStore(dir, { backend }).save(testToken);
    hostname = "different-network-hostname";
    expect(await new SessionStore(dir, { backend }).load()).toEqual(testToken);
    hostname = "";
    expect(await new SessionStore(dir, { backend }).load()).toEqual(testToken);
  });

  it("uses independent random keys for different installations", async () => {
    const a = await getSessionEncryptionKey(path.join(dir, "a"), backend);
    const b = await getSessionEncryptionKey(path.join(dir, "b"), backend);
    expect(a.equals(b)).toBe(false);
    expect(a).toHaveLength(32);
  });

  it("canonicalizes a symlink to the same session directory", async () => {
    if (process.platform === "win32") return;
    const canonical = path.join(dir, "actual");
    const linked = path.join(dir, "linked");
    await fs.mkdir(canonical);
    await fs.symlink(canonical, linked);
    expect(await getSessionEncryptionKey(linked, backend)).toEqual(await getSessionEncryptionKey(canonical, backend));
    expect(backend.writes).toBe(1);
  });

  it("creates only one key for simultaneous callers", async () => {
    const keys = await Promise.all(Array.from({ length: 8 }, () => getSessionEncryptionKey(dir, backend)));
    for (const key of keys) expect(key).toEqual(keys[0]);
    expect(backend.writes).toBe(1);
  });

  it("rechecks a transient partial key read inside the initialization lock", async () => {
    const key = "ab".repeat(32);
    const transientBackend = {
      getPassword: vi.fn()
        .mockResolvedValueOnce("partially-written")
        .mockResolvedValue(key),
      setPassword: vi.fn(async () => {}),
      deletePassword: vi.fn(async () => {}),
    };

    expect(await getSessionEncryptionKey(dir, transientBackend)).toEqual(Buffer.from(key, "hex"));
    expect(transientBackend.setPassword).not.toHaveBeenCalled();
  });

  it("serializes master key creation across independent Node processes", async () => {
    const codeDir = path.join(dir, "worker-code");
    const sessionDir = path.join(dir, "session");
    await fs.mkdir(codeDir);
    await fs.writeFile(path.join(codeDir, "package.json"), JSON.stringify({ type: "module" }));
    for (const name of ["credential-store", "auth-lock"]) {
      const source = await fs.readFile(fileURLToPath(new URL(`../../src/auth/${name}.ts`, import.meta.url)), "utf8");
      const { outputText } = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 } });
      await fs.writeFile(path.join(codeDir, `${name}.js`), outputText);
    }
    const worker = `
      import { getSessionEncryptionKey } from './credential-store.js';
      import * as fs from 'node:fs/promises';
      import * as path from 'node:path';
      const dir = process.argv[1];
      const keyFile = path.join(dir, 'dummy-native-key');
      const backend = {
        async getPassword() {
          try { return await fs.readFile(keyFile, 'utf8'); }
          catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        async setPassword(service, account, key) {
          await fs.appendFile(path.join(dir, 'dummy-native-writes'), 'write\\n');
          await fs.writeFile(keyFile, key);
        },
        async deletePassword() {},
      };
      process.stdout.write((await getSessionEncryptionKey(dir, backend)).toString('hex'));
    `;
    const run = promisify(execFile);
    const results = await Promise.all(Array.from({ length: 5 }, () => run(process.execPath, ["--input-type=module", "-e", worker, sessionDir], { cwd: codeDir })));
    expect(new Set(results.map((result) => result.stdout)).size).toBe(1);
    expect(await fs.readFile(path.join(sessionDir, "dummy-native-writes"), "utf8")).toBe("write\n");
  });

  it("does not create a new key when a different encrypted store still needs the missing key", async () => {
    await fs.writeFile(path.join(dir, "storage-state.encrypted.json"), "encrypted-state-placeholder");
    await expect(getSessionEncryptionKey(dir, backend)).rejects.toThrow("encrypted authentication state still exists");
    expect(backend.writes).toBe(0);
  });
});
