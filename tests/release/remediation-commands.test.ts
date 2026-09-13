import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Guardrail for the failure that motivated all of this.
 *
 * `npx brightspace-mcp-server auth` without the @latest tag prefers a binary
 * already on PATH. On a machine with an old global install it silently runs
 * that stale copy. A healthy v2.0.0 server once printed exactly that command
 * and sent a user into v1.2.6, whose sign-in flow no longer worked.
 *
 * Every user-facing command must therefore be pinned. Import the constants
 * from src/utils/commands.ts rather than writing the command inline.
 */

const repoRoot = resolve(__dirname, "..", "..");

/** `npx [-y] brightspace-mcp-server` not immediately followed by @latest. */
const UNPINNED = /npx\s+(?:-y\s+)?brightspace-mcp-server(?!@latest)/g;

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "build" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

function findUnpinned(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line, i) => {
        if (new RegExp(UNPINNED.source).test(line)) {
          hits.push(`${file.replace(repoRoot + "/", "")}:${i + 1}  ${line.trim()}`);
        }
      });
  }
  return hits;
}

describe("remediation commands are pinned to @latest", () => {
  it("has no unpinned npx command in src/", () => {
    const hits = findUnpinned(walk(resolve(repoRoot, "src"), [".ts"]));
    expect(hits, `Unpinned commands found:\n${hits.join("\n")}`).toEqual([]);
  });

  it("has no unpinned npx command in user-facing docs", () => {
    const docs = ["README.md", "LLMs.md"]
      .map((f) => resolve(repoRoot, f))
      .filter((f) => {
        try {
          statSync(f);
          return true;
        } catch {
          return false;
        }
      });
    const hits = findUnpinned(docs);
    expect(hits, `Unpinned commands found:\n${hits.join("\n")}`).toEqual([]);
  });

  it("never tells a user to run the bare brightspace-auth binary", () => {
    // That shim only exists after `npm install -g`. The documented install is
    // npx, so for most users the command simply does not exist.
    const files = walk(resolve(repoRoot, "src"), [".ts"]);
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf-8").split("\n").forEach((line, i) => {
        if (!/`brightspace-auth`|Run brightspace-auth/.test(line)) return;
        hits.push(`${file.replace(repoRoot + "/", "")}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(hits, `Unpinned bare command found:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the regex actually catches the form that caused the incident", () => {
    expect(new RegExp(UNPINNED.source).test("npx brightspace-mcp-server auth")).toBe(true);
    expect(new RegExp(UNPINNED.source).test("npx -y brightspace-mcp-server setup")).toBe(true);
    expect(new RegExp(UNPINNED.source).test("npx brightspace-mcp-server@latest auth")).toBe(false);
    expect(new RegExp(UNPINNED.source).test("npx -y brightspace-mcp-server@latest auth")).toBe(false);
    expect(new RegExp(UNPINNED.source).test("npx clear-npx-cache")).toBe(false);
  });
});
