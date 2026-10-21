import { describe, expect, it } from "vitest";
import { parseSetupArgs } from "../../src/setup/args.js";
import { SCHOOL_PRESETS } from "../../src/setup/presets.js";

/**
 * `setup`'s flags. An agent drives `--prepare` and hands the person
 * `--sign-in`, so a mistyped flag must fail loudly: ignoring it would drop the
 * agent into the interactive wizard, which waits for typing that never comes.
 */

const parse = (...flags: string[]) => parseSetupArgs(["node", "index.js", "setup", ...flags]);
const ok = (...flags: string[]) => {
  const result = parse(...flags);
  if (!result.ok) throw new Error(result.error);
  return result.args;
};

describe("parseSetupArgs", () => {
  it("defaults to the wizard with nothing else set", () => {
    expect(ok()).toEqual({ mode: "wizard", json: false, replace: false, installBrowser: true, help: false });
  });

  it("finds the school flag in any position", () => {
    expect(ok("--purdue", "--prepare").preset).toBe(SCHOOL_PRESETS.purdue);
    expect(ok("--prepare", "--json", "--purdue").preset).toBe(SCHOOL_PRESETS.purdue);
    expect(ok("--prepare", "--SUNY").school).toBe("suny");
  });

  it("reads the brightspace-setup bin's argv, which has no subcommand", () => {
    const result = parseSetupArgs(["node", "setup.js", "--cuny", "--sign-in"]);
    expect(result.ok && result.args.preset).toBe(SCHOOL_PRESETS.cuny);
    expect(result.ok && result.args.mode).toBe("sign-in");
  });

  it("takes values as --flag value and --flag=value", () => {
    const args = ok("--prepare", "--url", "school.brightspace.com", "--username=alice", "--campus", "SUNY Poly");
    expect(args).toMatchObject({ url: "school.brightspace.com", username: "alice", campus: "SUNY Poly" });
  });

  it("reads the prepare switches", () => {
    expect(ok("--purdue", "--prepare", "--json", "--replace", "--no-browser-install")).toMatchObject({
      mode: "prepare",
      json: true,
      replace: true,
      installBrowser: false,
    });
  });

  it("does not resolve inherited object keys as schools", () => {
    for (const key of ["constructor", "__proto__", "toString"]) {
      expect(parse(`--${key}`)).toEqual({ ok: false, error: `Unknown option: --${key.toLowerCase()}` });
    }
  });

  it.each([
    [["--prepar"], "Unknown option: --prepar"],
    [["--prepare", "--sign-in"], "Use either --prepare or --sign-in, not both."],
    [["--purdue", "--url", "x.brightspace.com"], "Pass either a school flag or --url, not both."],
    [["--purdue", "--cuny"], "Pass only one school flag."],
    [["--username"], "--username needs a value."],
    [["--username", "--prepare"], "--username needs a value."],
    [["--json"], "--json works only with --prepare."],
    [["--prepare=yes"], "--prepare does not take a value."],
    [["purdue"], "Unexpected argument: purdue"],
  ])("rejects %j", (flags, error) => {
    expect(parse(...flags)).toEqual({ ok: false, error });
  });

  it("accepts --help and -h", () => {
    expect(ok("--help").help).toBe(true);
    expect(ok("-h").help).toBe(true);
  });
});
