import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tsconfig = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "tsconfig.json"),
    "utf8",
  ),
);

// `npm run build` is CI's type-check step, so these flags are what make dead
// code (like the never-read D2LApiClient cacheTTLs option, #390) fail CI.
describe("tsconfig unused-code checks", () => {
  it("fails the build on unused locals", () => {
    expect(tsconfig.compilerOptions.noUnusedLocals).toBe(true);
  });

  it("fails the build on unused parameters", () => {
    expect(tsconfig.compilerOptions.noUnusedParameters).toBe(true);
  });
});
