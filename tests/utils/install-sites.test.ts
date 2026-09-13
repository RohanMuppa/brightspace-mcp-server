import { describe, it, expect, vi } from "vitest";
import { scanInstallSites, formatSkewNotice, type InstallSite } from "../../src/utils/install-sites.js";

/**
 * Regression coverage for the incident: a v2.0.0 server running while
 * `brightspace-auth` in the shell resolved to a v1.2.6 copy installed under a
 * different Node version. Nothing surfaced the mismatch.
 *
 * The scan must find that copy even when PATH does not mention it, because a
 * GUI-launched MCP client inherits a minimal PATH with no version-manager
 * directory in it.
 */

const HOME = "/Users/me";
const NVM = `${HOME}/.nvm/versions/node`;

/** The machine as it actually was when the incident happened. */
function incidentMachine() {
  const versions: Record<string, string> = {
    [`${NVM}/v24.11.0/lib/node_modules/brightspace-mcp-server/package.json`]: "1.2.6",
    [`${NVM}/v24.19.0/lib/node_modules/brightspace-mcp-server/package.json`]: "2.0.0",
    [`${HOME}/.npm/_npx/903d6b2f/node_modules/brightspace-mcp-server/package.json`]: "1.2.6",
    [`${HOME}/.npm/_npx/e022c579/node_modules/brightspace-mcp-server/package.json`]: "2.0.0",
  };

  return {
    env: { PATH: "/usr/bin:/bin" }, // deliberately minimal, as under launchd
    platform: "darwin" as NodeJS.Platform,
    execPath: `${NVM}/v24.19.0/bin/node`,
    home: HOME,
    selfDir: `${HOME}/.npm/_npx/e022c579/node_modules/brightspace-mcp-server`,
    readVersion: async (p: string) => versions[p] ?? null,
    listDir: async (dir: string) => {
      if (dir === NVM) return ["v24.11.0", "v24.19.0"];
      if (dir === `${HOME}/.npm/_npx`) return ["903d6b2f", "e022c579"];
      return [];
    },
    realpath: async (p: string) => {
      throw new Error(`no shim at ${p}`);
    },
  };
}

describe("scanInstallSites", () => {
  it("finds a stale copy under a different Node version, with a minimal PATH", async () => {
    const sites = await scanInstallSites(incidentMachine());
    const stale = sites.find((s) => s.dir.includes("v24.11.0"));

    expect(stale).toBeDefined();
    expect(stale!.version).toBe("1.2.6");
    expect(stale!.kind).toBe("global");
    expect(stale!.isSelf).toBe(false);
  });

  it("marks the running copy as self so it is not reported against itself", async () => {
    const sites = await scanInstallSites(incidentMachine());
    const self = sites.filter((s) => s.isSelf);

    expect(self).toHaveLength(1);
    expect(self[0].kind).toBe("self");
    expect(self[0].dir).toContain("e022c579");
  });

  it("classifies npx cache entries", async () => {
    const sites = await scanInstallSites(incidentMachine());
    const cached = sites.filter((s) => s.kind === "npx-cache");

    expect(cached.map((s) => s.version).sort()).toEqual(["1.2.6"]);
  });

  it("records which PATH entry a shell command resolves to", async () => {
    const deps = incidentMachine();
    const sites = await scanInstallSites({
      ...deps,
      env: { PATH: `${NVM}/v24.11.0/bin:/usr/bin` },
      realpath: async (p: string) => {
        if (p === `${NVM}/v24.11.0/bin/brightspace-auth`) {
          return `${NVM}/v24.11.0/lib/node_modules/brightspace-mcp-server/build/auth-cli.js`;
        }
        throw new Error("no shim");
      },
    });

    const resolved = sites.find((s) => s.binPath);
    expect(resolved).toBeDefined();
    expect(resolved!.binPath).toBe(`${NVM}/v24.11.0/bin/brightspace-auth`);
    expect(resolved!.version).toBe("1.2.6");
  });

  it("returns nothing when the package is installed nowhere", async () => {
    const sites = await scanInstallSites({
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      execPath: "/usr/bin/node",
      home: HOME,
      readVersion: async () => null,
      listDir: async () => [],
      realpath: async () => {
        throw new Error("none");
      },
    });
    expect(sites).toEqual([]);
  });

  it("does not attempt shim resolution on Windows", async () => {
    const realpath = vi.fn(async () => {
      throw new Error("should not be called");
    });
    await scanInstallSites({
      env: { PATH: "C:\\bin", APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      home: "C:\\Users\\me",
      readVersion: async () => null,
      listDir: async () => [],
      realpath,
    });
    expect(realpath).not.toHaveBeenCalled();
  });
});

describe("formatSkewNotice", () => {
  const site = (over: Partial<InstallSite>): InstallSite => ({
    kind: "global",
    dir: `${NVM}/v24.11.0/lib/node_modules/brightspace-mcp-server`,
    version: "1.2.6",
    isSelf: false,
    ...over,
  });

  it("is silent when every copy agrees", () => {
    const sites = [site({ version: "2.0.0" }), site({ version: "2.0.0", dir: "/other" })];
    expect(formatSkewNotice(sites, "2.0.0", HOME)).toBeNull();
  });

  it("is silent when the only copy is the running one", () => {
    expect(formatSkewNotice([site({ isSelf: true, kind: "self" })], "2.0.0", HOME)).toBeNull();
  });

  it("is silent with nothing found at all", () => {
    expect(formatSkewNotice([], "2.0.0", HOME)).toBeNull();
  });

  it("names the stale version and shortens the home path", () => {
    const notice = formatSkewNotice([site({})], "2.0.0", HOME);
    expect(notice).toContain("v2.0.0");
    expect(notice).toContain("v1.2.6");
    expect(notice).toContain("~/.nvm/versions/node/v24.11.0");
    expect(notice).not.toContain(HOME); // the literal home path is replaced by ~
  });

  it("leads with the copy a shell command resolves to", () => {
    const notice = formatSkewNotice(
      [
        site({ dir: "/somewhere/else", version: "1.5.0" }),
        site({ binPath: `${NVM}/v24.11.0/bin/brightspace-auth` }),
      ],
      "2.0.0",
      HOME
    );
    const lines = notice!.split("\n");
    expect(lines[1]).toContain("brightspace-auth");
    expect(notice).toMatch(/fails during sign-in/);
  });

  it("caps how many copies it lists", () => {
    const many = ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"].map((v, i) =>
      site({ version: v, dir: `/root${i}/node_modules/brightspace-mcp-server` })
    );
    const notice = formatSkewNotice(many, "2.0.0", HOME);
    expect(notice).toContain("and 2 more");
  });

  it("ignores copies whose version could not be read", () => {
    expect(formatSkewNotice([site({ version: null })], "2.0.0", HOME)).toBeNull();
  });
});
