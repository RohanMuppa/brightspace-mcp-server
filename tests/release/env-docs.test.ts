import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Issue #252: README points to LLMs.md for "the full list" of settings, but
 * LLMs.md had drifted to naming fewer than half of the D2L_* variables the
 * server reads. Every D2L_* name in src/ must be in LLMs.md's
 * "Environment variables" table unless it is listed here as internal.
 */

const INTERNAL = new Set([
  // Set by the auth CLI on its own re-exec, never by a user.
  "D2L_REEXECED",
  // Generated per authentication attempt and passed only to its child.
  "D2L_DEV_RECOVERY_ID",
  // Code constants for the d2lSessionVal / d2lSecureSessionVal cookie names.
  "D2L_SESSION_VAL",
  "D2L_SECURE_SESSION_VAL",
]);

const root = resolve(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const namesInSource = new Set(
  sourceFiles(join(root, "src")).flatMap((file) => readFileSync(file, "utf-8").match(/\bD2L_[A-Z_]+\b/g) ?? [])
);

// Windows checkouts may convert to CRLF; match on LF regardless.
const llms = readFileSync(join(root, "LLMs.md"), "utf-8").replace(/\r\n/g, "\n");

function section(heading: string): string {
  const start = llms.indexOf(`## ${heading}\n`);
  expect(start, `LLMs.md has no "## ${heading}" section`).toBeGreaterThanOrEqual(0);
  const next = llms.indexOf("\n## ", start + 1);
  return llms.slice(start, next === -1 ? undefined : next);
}

describe("LLMs.md environment variable reference", () => {
  const table = section("Environment variables");

  it("finds the variables it is meant to guard", () => {
    // A broken scan would make the check below pass vacuously.
    expect(namesInSource).toContain("D2L_BASE_URL");
    expect(namesInSource).toContain("D2L_CURRENT_ONLY");
  });

  it("names every user-facing D2L_* variable the server reads", () => {
    const missing = [...namesInSource]
      .filter((name) => !INTERNAL.has(name))
      .filter((name) => !table.includes(`| \`${name}\` |`))
      .sort();
    expect(missing, "add these to the Environment variables table in LLMs.md, or to INTERNAL here").toEqual([]);
  });

  it("keeps the internal allowlist honest", () => {
    for (const name of INTERNAL) expect(namesInSource, `${name} is no longer in src/`).toContain(name);
  });
});
