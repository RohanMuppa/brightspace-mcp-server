import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "publish.yml"), "utf8").replace(/\r\n/g, "\n");
const posix = process.platform !== "win32";

describe("publish workflow", () => {
  it("runs one publish at a time and never cancels one in progress", () => {
    // Two merges once published concurrently and the older version finished last,
    // leaving npm's `latest` on it.
    expect(workflow).toMatch(/^concurrency:\n  group: publish-npm\n  cancel-in-progress: false$/m);
  });

  it("publishes only a version greater than the one on npm", () => {
    const step = workflow.slice(workflow.indexOf("- name: Publish if version changed"), workflow.indexOf("# Tags the commit"));
    expect(step).toContain("IS_NEWER");
    expect(step).not.toMatch(/\[ "\$CURRENT" != "\$PUBLISHED" \]/);
    expect(step).not.toContain('|| echo "0.0.0"');
  });

  it("publishes a prerelease under the next tag, never latest", () => {
    expect(workflow).toContain('case "$CURRENT" in *-*) TAG=next ;; esac');
    expect(workflow).toContain('npm publish --provenance --access public --tag "$TAG"');
  });

  describe("version comparison", () => {
    const script = /IS_NEWER=\$\(node -e '([\s\S]*?)' "\$CURRENT" "\$PUBLISHED"\)/.exec(workflow)?.[1];
    const newer = (a: string, b: string) => execFileSync("node", ["-e", script!, a, b], { encoding: "utf8" }).trim() === "true";

    it("is present", () => expect(script).toBeTruthy());

    it.each([
      ["5.1.43", "5.1.42", true],
      ["5.1.42", "5.1.43", false],
      ["5.1.43", "5.1.43", false],
      ["5.10.0", "5.9.9", true],
      ["5.2.0", "5.1.43", true],
      ["6.0.0", "5.99.99", true],
      ["5.1.43", "0.0.0", true],
    ])("compares %s with %s numerically: %s", (a, b, expected) => expect(newer(a, b)).toBe(expected));

    it.each([
      ["1.0.0", "1.0.0-rc.1", true],
      ["1.0.0-rc.1", "1.0.0", false],
      ["1.0.0-rc.2", "1.0.0-rc.1", true],
      ["1.0.0-rc.10", "1.0.0-rc.2", true],
      ["1.0.0-beta", "1.0.0-alpha", true],
      ["1.0.0-alpha.1", "1.0.0-alpha", true],
      ["1.0.0-alpha", "1.0.0-alpha.1", false],
      ["1.0.0-1", "1.0.0-alpha", false],
      ["1.0.0-alpha", "1.0.0-1", true],
      ["1.0.0-rc.1", "1.0.0-rc.1", false],
      ["5.3.0-beta.1", "5.2.0", true],
      ["1.0.0+build.5", "1.0.0", false],
    ])("follows semver precedence for prereleases: %s vs %s", (a, b, expected) => expect(newer(a, b)).toBe(expected));
  });

  describe.runIf(posix)("reading npm's answer", () => {
    const fn = /(npm_version\(\) \{[\s\S]*?\n          \})/.exec(workflow)?.[1].replace(/^ {10}/gm, "");

    const ask = (npmBody: string) => {
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-npm-"));
      try {
        fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\n${npmBody}\n`, { mode: 0o755 });
        const result = spawnSync("bash", ["-c", `${fn}\nnpm_version some-pkg; echo "[rc=$?]"`], {
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        });
        return { out: result.stdout, err: result.stderr };
      } finally {
        fs.rmSync(bin, { recursive: true, force: true });
      }
    };

    it("is present", () => expect(fn).toBeTruthy());

    it("returns the version npm reports", () => {
      expect(ask('echo "5.1.43"').out).toBe("5.1.43[rc=0]\n");
    });

    it("treats E404 as never published: empty answer, success", () => {
      expect(ask('echo "npm error code E404" >&2; exit 1').out).toBe("[rc=0]\n");
    });

    it("fails hard on any other npm failure instead of falling back to 0.0.0", () => {
      const { out, err } = ask('echo "npm error code ETIMEDOUT" >&2; exit 1');
      expect(out).toBe("[rc=1]\n");
      expect(err).toContain("::error::npm view some-pkg failed");
    });
  });
});
