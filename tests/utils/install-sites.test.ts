import { describe, it, expect, vi } from "vitest";
import { dirname, join, resolve, sep, delimiter } from "node:path";
import { scanInstallSites, formatSkewNotice, type InstallSite } from "../../src/utils/install-sites.js";

/**
 * Regression coverage for the incident: a v2.0.0 server running while the auth
 * command in the shell resolved to a v1.2.6 copy installed under a different
 * Node version. Nothing surfaced the mismatch.
 *
 * The scan must find that copy even when PATH does not mention it, because a
 * GUI-launched MCP client inherits a minimal PATH with no version-manager
 * directory in it.
 *
 * Every fixture path is built with join/resolve rather than written with "/".
 * The scanner uses the platform's own path functions, so POSIX string literals
 * silently match nothing on Windows and the suite passes for the wrong reason
 * (or, as it did, fails outright).
 */

const HOME = resolve(sep, "Users", "me");
const NVM = join(HOME, ".nvm", "versions", "node");
const NPX = join(HOME, ".npm", "_npx");
const PKG = "brightspace-mcp-server";

const nvmPkg = (version: string) => join(NVM, version, "lib", "node_modules", PKG);
const npxPkg = (hash: string) => join(NPX, hash, "node_modules", PKG);

/** The machine as it actually was when the incident happened. */
function incidentMachine() {
  const versions: Record<string, string> = {
    [join(nvmPkg("v24.11.0"), "package.json")]: "1.2.6",
    [join(nvmPkg("v24.19.0"), "package.json")]: "2.0.0",
    [join(npxPkg("903d6b2f"), "package.json")]: "1.2.6",
    [join(npxPkg("e022c579"), "package.json")]: "2.0.0",
  };

  return {
    // Deliberately minimal, as a GUI client inherits under launchd.
    env: { PATH: [join(sep, "usr", "bin"), join(sep, "bin")].join(delimiter) },
    execPath: join(NVM, "v24.19.0", "bin", "node"),
    home: HOME,
    selfDir: npxPkg("e022c579"),
    readVersion: async (p: string) => versions[p] ?? null,
    listDir: async (dir: string) => {
      if (dir === NVM) return ["v24.11.0", "v24.19.0"];
      if (dir === NPX) return ["903d6b2f", "e022c579"];
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
    const stale = sites.find((s) => s.dir === resolve(nvmPkg("v24.11.0")));

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
    expect(self[0].dir).toBe(resolve(npxPkg("e022c579")));
  });

  it("classifies npx cache entries", async () => {
    const sites = await scanInstallSites(incidentMachine());
    const cached = sites.filter((s) => s.kind === "npx-cache");

    expect(cached.map((s) => s.version)).toEqual(["1.2.6"]);
  });

  it("returns nothing when the package is installed nowhere", async () => {
    const sites = await scanInstallSites({
      env: { PATH: join(sep, "usr", "bin") },
      execPath: join(sep, "usr", "bin", "node"),
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
    // Shims there are .cmd wrappers, not symlinks into the package, so
    // realpath would resolve to the wrapper and tell us nothing.
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

// realpath-based shim resolution is POSIX-only in the scanner, so this case
// cannot run on Windows at all.
describe.skipIf(process.platform === "win32")("scanInstallSites: shim resolution", () => {
  it("records which PATH entry a shell command resolves to", async () => {
    const deps = incidentMachine();
    const binDir = join(NVM, "v24.11.0", "bin");
    const shim = join(binDir, "brightspace-auth");

    const sites = await scanInstallSites({
      ...deps,
      env: { PATH: [binDir, join(sep, "usr", "bin")].join(delimiter) },
      realpath: async (p: string) => {
        if (p === shim) return join(nvmPkg("v24.11.0"), "build", "auth-cli.js");
        throw new Error("no shim");
      },
    });

    const resolved = sites.find((s) => s.binPath);
    expect(resolved).toBeDefined();
    expect(resolved!.binPath).toBe(shim);
    expect(resolved!.version).toBe("1.2.6");
  });

  it("uses the first matching PATH entry for each shell command", async () => {
    const deps = incidentMachine();
    const currentBin = join(NVM, "v24.19.0", "bin");
    const staleBin = join(NVM, "v24.11.0", "bin");

    const sites = await scanInstallSites({
      ...deps,
      env: { PATH: [currentBin, staleBin].join(delimiter) },
      realpath: async (p: string) => {
        if (dirname(p) === currentBin) return join(nvmPkg("v24.19.0"), "build", "auth-cli.js");
        if (dirname(p) === staleBin) return join(nvmPkg("v24.11.0"), "build", "auth-cli.js");
        throw new Error("no shim");
      },
    });

    const resolved = sites.filter((s) => s.binPath);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].dir).toBe(resolve(nvmPkg("v24.19.0")));
  });
});

describe("formatSkewNotice", () => {
  const site = (over: Partial<InstallSite>): InstallSite => ({
    kind: "global",
    dir: nvmPkg("v24.11.0"),
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

  it("names an actionable stale version and shortens the home path", () => {
    const notice = formatSkewNotice(
      [site({ binPath: join(NVM, "v24.11.0", "bin", "brightspace-auth") })],
      "2.0.0",
      HOME
    );
    expect(notice).toContain("v2.0.0");
    expect(notice).toContain("v1.2.6");
    expect(notice).toContain("~");
    // The literal home prefix is replaced by ~, never printed in full.
    expect(notice).not.toContain(HOME);
  });

  it("ignores dormant installs while reporting a shell-resolved copy", () => {
    const notice = formatSkewNotice(
      [
        site({ dir: join(sep, "somewhere", "else"), version: "1.5.0" }),
        site({ binPath: join(NVM, "v24.11.0", "bin", "brightspace-auth") }),
      ],
      "2.0.0",
      HOME
    );
    expect(notice!.split("\n")[1]).toContain("brightspace-auth");
    expect(notice).not.toContain("somewhere");
    expect(notice).toMatch(/fails during sign-in/);
  });

  it("is silent for stale installs that are not shell-resolved", () => {
    const dormant = [
      site({}),
      site({ kind: "npx-cache", dir: npxPkg("old"), version: "1.0.0" }),
    ];
    expect(formatSkewNotice(dormant, "2.0.0", HOME)).toBeNull();
  });

  it("ignores copies whose version could not be read", () => {
    expect(formatSkewNotice([site({ version: null })], "2.0.0", HOME)).toBeNull();
  });
});
