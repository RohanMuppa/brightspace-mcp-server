import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The built entry point, run as a real process. A mistyped subcommand such as
 * `htp` must fail with the usage text instead of quietly starting a stdio
 * server that waits on stdin. With no argument, stdio stays the default.
 * CI builds before testing; locally, run `npm run build` first.
 */

const indexJs = path.resolve(__dirname, "..", "..", "build", "index.js");

function run(...args: string[]) {
  const home = mkdtempSync(path.join(os.tmpdir(), "entry-cli-"));
  try {
    const result = spawnSync(process.execPath, [indexJs, ...args], {
      input: "",
      encoding: "utf-8",
      env: { ...process.env, HOME: home, USERPROFILE: home, D2L_NO_UPDATE_CHECK: "1", VITEST: "" },
      timeout: 20_000,
    });
    return { ...result, homeEntries: readdirSync(home) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(!existsSync(indexJs))("entry point subcommand routing", () => {
  it.each([["htp"], ["htp", "--port", "4000"], ["serve"]])("fails fast on the unknown command %j with usage", (...args) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`Unknown command: ${args[0]}`);
    expect(result.stderr).toContain("http");
    expect(result.stderr).toContain("setup");
  });

  it("starts nothing for an unknown command", () => {
    const result = run("htp");
    expect(result.stderr).not.toContain("running on stdio");
    expect(result.stderr).not.toContain("listening on");
    expect(result.homeEntries).toEqual([]);
  });

  it("still starts the stdio server with no command", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Unknown command");
    expect(result.stderr).toContain("running on stdio");
  });
});
