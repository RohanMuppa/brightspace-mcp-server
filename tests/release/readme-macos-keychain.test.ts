import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Issue #132: on macOS a one-time Keychain "Allow" is not enough for later
 * headless `auth` or MCP requests; "Always Allow" is. The README must say so
 * where users set up and sign in, and in troubleshooting.
 */

// Windows checkouts may convert the README to CRLF; match on LF regardless.
const readme = readFileSync(resolve(__dirname, "..", "..", "README.md"), "utf-8").replace(/\r\n/g, "\n");

/** Body of the `## <heading>` section, up to the next `## ` heading. */
function section(heading: string): string {
  const start = readme.indexOf(`## ${heading}\n`);
  expect(start, `README has no "## ${heading}" section`).toBeGreaterThanOrEqual(0);
  const next = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
}

describe("README explains the macOS credential-store prompt", () => {
  it("tells setup users to choose Always Allow, in bold", () => {
    expect(section("Get started in 3 steps")).toContain("**Always Allow**");
  });

  it("warns in the sign-in section that a one-time Allow can make later requests fail or hang", () => {
    expect(section("When it asks you to sign in")).toMatch(/one-time \*\*Allow\*\*[^\n]*(fail|hang)/);
  });

  it("has a troubleshooting entry quoting the native credential-store error", () => {
    expect(section("Something not working?")).toContain(
      "The native credential store is locked or unavailable",
    );
  });

  it("gives the recovery path of unlocking, rerunning auth, and granting Always Allow", () => {
    const entry = section("Something not working?")
      .split("\n")
      .find((line) => line.includes("The native credential store is locked or unavailable"));
    expect(entry).toMatch(/unlock[\s\S]*auth[\s\S]*\*\*Always Allow\*\*/i);
  });

  it("clarifies the permission only lets the local server read its own saved credential", () => {
    expect(section("When it asks you to sign in")).toMatch(/only lets[^\n]*its own saved/i);
  });
});
