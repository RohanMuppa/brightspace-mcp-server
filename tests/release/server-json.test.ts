import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * server.json is the MCP registry manifest. Registry entries are pinned to
 * a version, so a manifest that lags package.json advertises a stale
 * package. Keep the two in lockstep; bump both in the same commit.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name: string) => JSON.parse(readFileSync(resolve(root, name), "utf-8"));

describe("server.json", () => {
  const pkg = read("package.json");
  const manifest = read("server.json");

  it("carries the same version as package.json at the top level", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("carries the same version on the npm package entry", () => {
    expect(manifest.packages).toHaveLength(1);
    expect(manifest.packages[0].identifier).toBe(pkg.name);
    expect(manifest.packages[0].version).toBe(pkg.version);
  });

  it("declares the environment variables the server reads", () => {
    const names = (manifest.packages[0].environmentVariables ?? []).map(
      (v: { name: string }) => v.name
    );
    for (const expected of [
      "D2L_BASE_URL",
      "D2L_SESSION_DIR",
      "D2L_HEADLESS",
      "D2L_TOKEN_TTL",
      "D2L_INCLUDE_COURSES",
      "D2L_EXCLUDE_COURSES",
      "D2L_ACTIVE_ONLY",
      "D2L_NO_UPDATE_CHECK",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
