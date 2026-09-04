import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic, writeFileAtomicSync } from "../../src/utils/atomic-write.js";

/**
 * A crash or a second writer mid-write must never leave a truncated
 * session or config file. Stage to a sibling temp file, then rename.
 */

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), "bmcp-atomic-"));
const isWindows = process.platform === "win32";

describe("writeFileAtomic", () => {
  it("writes the content and leaves no temp file behind", async () => {
    const dir = await tmpDir();
    const target = path.join(dir, "session.json");
    await writeFileAtomic(target, '{"a":1}');
    expect(await fs.readFile(target, "utf-8")).toBe('{"a":1}');
    const leftovers = (await fs.readdir(dir)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("replaces an existing file completely", async () => {
    const dir = await tmpDir();
    const target = path.join(dir, "config.json");
    await writeFileAtomic(target, "a much longer first payload that must vanish");
    await writeFileAtomic(target, "short");
    expect(await fs.readFile(target, "utf-8")).toBe("short");
  });

  it.skipIf(isWindows)("applies the requested mode", async () => {
    const dir = await tmpDir();
    const target = path.join(dir, "secret");
    await writeFileAtomic(target, "x", { mode: 0o600 });
    const mode = (await fs.stat(target)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("retries a rename that fails transiently", async () => {
    const dir = await tmpDir();
    const target = path.join(dir, "retry.json");
    let calls = 0;
    const renameImpl = vi.fn(async (from: string, to: string) => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("busy"), { code: "EPERM" });
      }
      await fs.rename(from, to);
    });
    await writeFileAtomic(target, "ok", { renameImpl, sleep: async () => {} });
    expect(renameImpl).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(target, "utf-8")).toBe("ok");
  });

  it("gives up after repeated failures and cleans up the temp file", async () => {
    const dir = await tmpDir();
    const target = path.join(dir, "never.json");
    const renameImpl = vi.fn(async () => {
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    });
    await expect(
      writeFileAtomic(target, "x", { renameImpl, sleep: async () => {} })
    ).rejects.toThrow("locked");
    const leftovers = (await fs.readdir(dir)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it("does not retry a non-transient error", async () => {
    const dir = await tmpDir();
    const target = path.join(dir, "enoent.json");
    const renameImpl = vi.fn(async () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    await expect(
      writeFileAtomic(target, "x", { renameImpl, sleep: async () => {} })
    ).rejects.toThrow("gone");
    expect(renameImpl).toHaveBeenCalledTimes(1);
  });
});

describe("writeFileAtomicSync", () => {
  it("writes the content and leaves no temp file behind", async () => {
    const dir = await tmpDir();
    const target = path.join(dir, "config.json");
    writeFileAtomicSync(target, "{}\n", { mode: 0o600 });
    expect(fsSync.readFileSync(target, "utf-8")).toBe("{}\n");
    const leftovers = fsSync.readdirSync(dir).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
