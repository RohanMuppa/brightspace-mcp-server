import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sensitiveDestination } from "../../src/utils/sensitive-paths.js";

const posix = process.platform !== "win32";

let home: string;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sensitive-home-")));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("sensitiveDestination", () => {
  it("refuses the home directory itself but not a folder inside it", async () => {
    await fs.mkdir(path.join(home, "Documents", "ECE"), { recursive: true });
    expect(await sensitiveDestination(home, home)).toMatch(/home/i);
    expect(await sensitiveDestination(path.join(home, "Documents"), home)).toBeNull();
    expect(await sensitiveDestination(path.join(home, "Documents", "ECE"), home)).toBeNull();
  });

  it.each([".ssh", ".gnupg", ".aws", ".config", "Library"])("refuses ~/%s and anything inside it", async (name) => {
    await fs.mkdir(path.join(home, name, "deep"), { recursive: true });
    expect(await sensitiveDestination(path.join(home, name), home)).not.toBeNull();
    expect(await sensitiveDestination(path.join(home, name, "deep"), home)).not.toBeNull();
  });

  it("refuses a folder that does not exist yet when it would be inside a protected one", async () => {
    await fs.mkdir(path.join(home, ".ssh"));
    expect(await sensitiveDestination(path.join(home, ".ssh", "new", "er"), home)).not.toBeNull();
  });

  it("follows a symlink into a protected folder", async () => {
    if (!posix) return;
    await fs.mkdir(path.join(home, ".ssh"));
    await fs.symlink(path.join(home, ".ssh"), path.join(home, "innocent"));
    expect(await sensitiveDestination(path.join(home, "innocent"), home)).not.toBeNull();
  });

  it("refuses the filesystem root", async () => {
    expect(await sensitiveDestination(path.parse(process.cwd()).root, home)).toMatch(/root/i);
  });

  it.runIf(posix)("refuses system folders", async () => {
    for (const dir of ["/etc", "/usr", "/usr/local", "/bin"]) {
      if (await fs.stat(dir).then(() => true, () => false)) expect(await sensitiveDestination(dir, home)).not.toBeNull();
    }
  });

  it.runIf(process.platform === "darwin")("refuses /System and compares case-insensitively", async () => {
    expect(await sensitiveDestination("/System", home)).not.toBeNull();
    expect(await sensitiveDestination("/SYSTEM/Library", home)).not.toBeNull();
    expect(await sensitiveDestination(path.join(home, ".SSH"), home)).not.toBeNull();
  });

  it("accepts an ordinary folder", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-"));
    try {
      expect(await sensitiveDestination(dir, home)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not treat a sibling that merely shares a prefix as protected", async () => {
    await fs.mkdir(path.join(home, ".sshfoo"));
    expect(await sensitiveDestination(path.join(home, ".sshfoo"), home)).toBeNull();
  });
});
