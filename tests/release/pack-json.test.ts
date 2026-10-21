import { describe, it, expect } from "vitest";
import { packedFilePaths } from "./pack-json.js";

const files = [{ path: "package.json" }, { path: "build/index.js" }];

describe("packedFilePaths", () => {
  it("reads the array shape older npm prints", () => {
    expect(packedFilePaths([{ name: "brightspace-mcp-server", files }])).toEqual([
      "package.json",
      "build/index.js",
    ]);
  });

  it("reads the package-keyed object shape npm 12 prints", () => {
    expect(packedFilePaths({ "brightspace-mcp-server": { name: "brightspace-mcp-server", files } })).toEqual([
      "package.json",
      "build/index.js",
    ]);
  });

  it("names the shape it got when it recognizes neither", () => {
    expect(() => packedFilePaths({ unexpected: true })).toThrow(/npm pack --json/);
    expect(() => packedFilePaths([])).toThrow(/npm pack --json/);
  });
});
