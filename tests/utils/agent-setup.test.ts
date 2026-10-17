import { describe, expect, it } from "vitest";
import type { ConfigStoreData } from "../../src/utils/config-store.js";
import type { Registration } from "../../src/utils/mcp-client-cli.js";

const { runAgentSetup, setupMode, signInTarget, presetForArgv, SCHOOL_PRESETS } = await import("../../src/setup.js");

const SIGN_IN = "npx -y brightspace-mcp-server@latest setup --sign-in";
const DOCTOR = "npx -y brightspace-mcp-server@latest doctor";

function fakeDeps(options: { existing?: ConfigStoreData | null; clients?: Array<{ displayName: string; registration: Registration }> } = {}) {
  const saved: ConfigStoreData[] = [];
  const written: string[] = [];
  return {
    saved,
    written,
    deps: {
      readExisting: () => options.existing ?? null,
      save: async (config: ConfigStoreData) => { saved.push(config); },
      clients: () => (options.clients ?? []).map(({ displayName, registration }) => ({
        displayName,
        inspect: () => registration,
        write: () => { written.push(displayName); return true; },
      })),
    },
  };
}

const agentArgv = (...flags: string[]) => ["node", "setup.js", "--agent", ...flags];

describe("setup mode", () => {
  it("is the interactive wizard with no mode flag", () => {
    expect(setupMode(["node", "setup.js", "--purdue"])).toBe("wizard");
  });

  it("is agent mode with --agent", () => {
    expect(setupMode(agentArgv("--purdue"))).toBe("agent");
  });

  it("is the human sign-in step with --sign-in", () => {
    expect(setupMode(["node", "setup.js", "--sign-in"])).toBe("sign-in");
  });

  it("still finds a school preset written after --agent", () => {
    expect(presetForArgv(agentArgv("--purdue"))).toBe(SCHOOL_PRESETS.purdue);
  });
});

describe("agent setup", () => {
  it("saves the school and username without any password", async () => {
    const { deps, saved } = fakeDeps();

    const result = await runAgentSetup(agentArgv("--url", "purdue.brightspace.com", "--username", "pete"), deps);

    expect(result.exitCode).toBe(0);
    expect(saved).toEqual([{ baseUrl: "https://purdue.brightspace.com", username: "pete", password: undefined, headless: true }]);
  });

  it("takes the school address from a preset flag", async () => {
    const { deps, saved } = fakeDeps();

    await runAgentSetup(agentArgv("--purdue", "--username", "pete"), deps);

    expect(saved[0].baseUrl).toBe(SCHOOL_PRESETS.purdue.baseUrl);
  });

  it("refuses a password flag and saves nothing", async () => {
    const { deps, saved } = fakeDeps();

    const result = await runAgentSetup(agentArgv("--purdue", "--username", "pete", "--password", "hunter2"), deps);

    expect({ exitCode: result.exitCode, saved }).toEqual({ exitCode: 2, saved: [] });
  });

  it("never echoes a refused flag's value", async () => {
    const { deps } = fakeDeps();

    const result = await runAgentSetup(agentArgv("--purdue", "--username", "pete", "--password", "hunter2"), deps);

    expect(result.lines.join("\n")).not.toContain("hunter2");
  });

  it("refuses to run without a username", async () => {
    const { deps, saved } = fakeDeps();

    const result = await runAgentSetup(agentArgv("--purdue"), deps);

    expect({ exitCode: result.exitCode, saved }).toEqual({ exitCode: 2, saved: [] });
  });

  it("refuses an address that is not a web address", async () => {
    const { deps } = fakeDeps();

    const result = await runAgentSetup(agentArgv("--url", "not a url", "--username", "pete"), deps);

    expect(result.exitCode).toBe(2);
  });

  it("requires a campus where several campuses share one site", async () => {
    const { deps } = fakeDeps();

    const result = await runAgentSetup(agentArgv("--suny", "--username", "abc@sunypoly.edu"), deps);

    expect(result.exitCode).toBe(2);
  });

  it("saves the campus it is given", async () => {
    const { deps, saved } = fakeDeps();

    await runAgentSetup(agentArgv("--suny", "--username", "abc@sunypoly.edu", "--campus", "SUNY Poly"), deps);

    expect(saved[0].campus).toBe("SUNY Poly");
  });

  it("keeps the saved sign-in choices on a rerun for the same school", async () => {
    const existing = { baseUrl: "https://purdue.brightspace.com", username: "pete", headless: false, rememberMfa: true };
    const { deps, saved } = fakeDeps({ existing });

    await runAgentSetup(agentArgv("--purdue", "--username", "pete"), deps);

    expect(saved[0]).toMatchObject({ headless: false, rememberMfa: true });
  });

  it("registers a client that has no Brightspace entry", async () => {
    const { deps, written } = fakeDeps({ clients: [{ displayName: "Cursor", registration: { state: "missing" } }] });

    await runAgentSetup(agentArgv("--purdue", "--username", "pete"), deps);

    expect(written).toEqual(["Cursor"]);
  });

  it("leaves a client entry that points somewhere else unchanged", async () => {
    const { deps, written } = fakeDeps({
      clients: [{ displayName: "Cursor", registration: { state: "different", current: "node /dev/build/index.js" } }],
    });

    await runAgentSetup(agentArgv("--purdue", "--username", "pete"), deps);

    expect(written).toEqual([]);
  });

  it("reports the client entry it left unchanged", async () => {
    const { deps } = fakeDeps({
      clients: [{ displayName: "Cursor", registration: { state: "different", current: "node /dev/build/index.js" } }],
    });

    const result = await runAgentSetup(agentArgv("--purdue", "--username", "pete"), deps);

    expect(result.lines.join("\n")).toContain("node /dev/build/index.js");
  });

  it("hands off to the human sign-in command", async () => {
    const { deps } = fakeDeps();

    const result = await runAgentSetup(agentArgv("--purdue", "--username", "pete"), deps);

    expect(result.lines.join("\n")).toContain(SIGN_IN);
  });

  it("tells the agent how to verify after the human signs in", async () => {
    const { deps } = fakeDeps();

    const result = await runAgentSetup(agentArgv("--purdue", "--username", "pete"), deps);

    expect(result.lines.join("\n")).toContain(DOCTOR);
  });
});

describe("sign-in step target", () => {
  it("uses the school and username the agent saved", () => {
    expect(signInTarget({ baseUrl: "https://purdue.brightspace.com", username: "pete", campus: "x" })).toEqual({
      baseUrl: "https://purdue.brightspace.com",
      username: "pete",
      campus: "x",
    });
  });

  it("has nothing to sign in to before setup has saved a school", () => {
    expect(signInTarget(null)).toBeNull();
  });

  it("has nothing to sign in to without a saved username", () => {
    expect(signInTarget({ baseUrl: "https://purdue.brightspace.com" })).toBeNull();
  });
});
