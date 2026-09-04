import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What actually ships is decided by the "files" array in package.json.
 * This pins the tarball contents so a broken array is caught here rather
 * than by the first user who installs a release with no build directory.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// On Windows npm is a .cmd shim. Node refuses to spawn one directly since the
// batch-injection fix in 2024, so it has to go through the shell there. Every
// argument below is a literal, so nothing user-supplied reaches cmd.exe.
const isWindows = process.platform === "win32";
const NPM = isWindows ? "npm.cmd" : "npm";

function packedPaths(): string[] {
  const out = execFileSync(NPM, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 120_000,
    shell: isWindows,
  });
  const [entry] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return entry.files.map((f) => f.path);
}

describe("npm pack", () => {
  const paths = packedPaths();

  it("ships the runtime files", () => {
    for (const required of ["package.json", "README.md", "LICENSE", "build/index.js"]) {
      expect(paths).toContain(required);
    }
  });

  it("does not ship sources, tests, or dependencies", () => {
    const leaked = paths.filter(
      (p) => p.startsWith("src/") || p.startsWith("tests/") || p.startsWith("node_modules/")
    );
    expect(leaked).toEqual([]);
  });

  it("points every bin entry at a built file", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
    for (const [name, rel] of Object.entries(pkg.bin as Record<string, string>)) {
      expect(paths, `${name} -> ${rel} is not in the tarball`).toContain(rel);
      expect(existsSync(resolve(root, rel)), `${name} -> ${rel} does not exist after build`).toBe(true);
    }
  });
});
