import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The built `setup` command, run the way an agent's shell runs it: stdin is a
 * pipe, not a terminal. The wizard and sign-in must refuse instead of waiting
 * for typing that never comes, and a bad flag must fail with the usage text.
 * CI builds before testing; locally, run `npm run build` first.
 */

const setupJs = path.resolve(__dirname, "..", "..", "build", "setup.js");

function run(...flags: string[]) {
  const home = mkdtempSync(path.join(os.tmpdir(), "setup-cli-"));
  try {
    return spawnSync(process.execPath, [setupJs, ...flags], {
      input: "",
      encoding: "utf-8",
      env: { ...process.env, HOME: home, USERPROFILE: home, VITEST: "" },
      timeout: 20_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(setupJs))("setup CLI without a terminal", () => {
  it.each([["--purdue", "--sign-in"], ["--purdue"]])("refuses to prompt for %j and points to --prepare", (...flags) => {
    const result = run(...flags);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("has to run in a terminal");
    expect(result.stderr).toContain("setup --purdue --prepare");
  });

  it("keeps --url in the prepare command it suggests", () => {
    const result = run("--url", "learn.example.edu", "--sign-in");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("setup --url https://learn.example.edu --prepare");
  });

  it("fails on an unknown flag with the usage text", () => {
    const result = run("--prepar");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown option: --prepar");
    expect(result.stderr).toContain("--prepare");
  });

  it("prints help", () => {
    const result = run("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--sign-in");
  });
});
