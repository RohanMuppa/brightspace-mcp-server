import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { PARTIAL_MAX_AGE_MS, removeStalePartials } from "../../src/sync/cleanup.js";
import { tempRoot } from "./harness.js";

let dir: string;
beforeEach(async () => {
  dir = await tempRoot();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const age = async (file: string, ms: number) => {
  const when = new Date(Date.now() - ms);
  await fs.utimes(file, when, when);
};

describe("removeStalePartials", () => {
  it("removes an old .download-<uuid>.part left by a killed run, at any depth", async () => {
    await fs.mkdir(path.join(dir, "Week 1", "Sub"), { recursive: true });
    const old = [path.join(dir, `.download-${UUID}.part`), path.join(dir, "Week 1", "Sub", `.download-${UUID}.part`)];
    for (const file of old) {
      await fs.writeFile(file, "half a file");
      await age(file, PARTIAL_MAX_AGE_MS + 60_000);
    }
    expect(await removeStalePartials(dir)).toBe(2);
    for (const file of old) await expect(fs.access(file)).rejects.toThrow();
  });

  it("leaves a recent one alone: it may belong to a run in progress elsewhere", async () => {
    const recent = path.join(dir, `.download-${UUID}.part`);
    await fs.writeFile(recent, "in progress");
    expect(await removeStalePartials(dir)).toBe(0);
    await fs.access(recent);
  });

  it("removes only the exact pattern", async () => {
    const keep = ["notes.part", ".download-x.part", `.download-${UUID}.part.bak`, `download-${UUID}.part`, `.download-${UUID.toUpperCase()}.parts`, "Lecture.pdf"];
    for (const name of keep) {
      await fs.writeFile(path.join(dir, name), "mine");
      await age(path.join(dir, name), PARTIAL_MAX_AGE_MS * 5);
    }
    expect(await removeStalePartials(dir)).toBe(0);
    expect((await fs.readdir(dir)).sort()).toEqual([...keep].sort());
  });

  it("does not remove a folder or a link that has the pattern's name", async () => {
    await fs.mkdir(path.join(dir, `.download-${UUID}.part`));
    await fs.writeFile(path.join(dir, `.download-${UUID}.part`, "inside.txt"), "x");
    expect(await removeStalePartials(dir)).toBe(0);
    await fs.access(path.join(dir, `.download-${UUID}.part`, "inside.txt"));
  });

  it.runIf(process.platform !== "win32")("never follows a symbolic link out of the destination, and never removes a link", async () => {
    const outside = await tempRoot();
    try {
      const victim = path.join(outside, `.download-${UUID}.part`);
      await fs.writeFile(victim, "not ours");
      await age(victim, PARTIAL_MAX_AGE_MS * 5);
      await fs.symlink(outside, path.join(dir, "link-out"));
      // A link with the pattern's own name, pointing at a file elsewhere.
      const target = path.join(outside, "target.txt");
      await fs.writeFile(target, "keep me");
      await fs.symlink(target, path.join(dir, `.download-${UUID.replace("123e", "aaaa")}.part`));
      expect(await removeStalePartials(dir)).toBe(0);
      await fs.access(victim);
      expect(await fs.readFile(target, "utf8")).toBe("keep me");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("does not look inside hidden folders", async () => {
    await fs.mkdir(path.join(dir, ".git"));
    const file = path.join(dir, ".git", `.download-${UUID}.part`);
    await fs.writeFile(file, "x");
    await age(file, PARTIAL_MAX_AGE_MS * 5);
    expect(await removeStalePartials(dir)).toBe(0);
    await fs.access(file);
  });

  it("copes with a missing destination and an unreadable folder", async () => {
    expect(await removeStalePartials(path.join(dir, "missing"))).toBe(0);
  });
});
