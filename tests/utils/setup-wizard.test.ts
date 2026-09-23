import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

/**
 * writeFileSync is wrapped so one test can make a write fail the way a full
 * disk does: the bytes it was handed land somewhere, and then it throws.
 */
const fsHooks = vi.hoisted(() => ({
  failWrite: null as null | ((target: string, data: unknown) => never),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync = (target: unknown, data: unknown, options?: unknown) => {
    if (fsHooks.failWrite) fsHooks.failWrite(String(target), data);
    return (actual.writeFileSync as (...args: unknown[]) => void)(target, data, options);
  };
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const { SCHOOL_PRESETS, buildConfigToSave, configureMcpClient, presetForArgv } =
  await import("../../src/setup.js");
const { createSSOFlow } = await import("../../src/auth/sso-flow.js");
const { SunySSOFlow } = await import("../../src/auth/suny-sso.js");
const { WesternSSOFlow } = await import("../../src/auth/western-sso.js");
const { PurdueSSOFlow } = await import("../../src/auth/purdue-sso.js");
type AppConfig = import("../../src/types/index.js").AppConfig;

let workDir: string;
let configPath: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-setup-"));
  configPath = path.join(workDir, "claude_desktop_config.json");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  fsHooks.failWrite = null;
  vi.restoreAllMocks();
  fs.rmSync(workDir, { recursive: true, force: true });
});

const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf-8"));

describe("school presets", () => {
  it("resolves every shipped preset from its flag", () => {
    for (const [flag, expected] of Object.entries(SCHOOL_PRESETS)) {
      expect(presetForArgv(["node", "setup.js", `--${flag}`])).toBe(expected);
    }
    expect(presetForArgv(["node", "setup.js", "--WESTERN"])).toBe(SCHOOL_PRESETS.western);
  });

  it("ignores flags that are not presets, including inherited object keys", () => {
    expect(presetForArgv(["node", "setup.js"])).toBeUndefined();
    expect(presetForArgv(["node", "setup.js", "--not-a-school"])).toBeUndefined();
    for (const inherited of ["constructor", "__proto__", "toString", "valueOf"]) {
      expect(presetForArgv(["node", "setup.js", `--${inherited}`])).toBeUndefined();
    }
  });

  it("gives every preset an https origin the auth layer can match", () => {
    for (const preset of Object.values(SCHOOL_PRESETS)) {
      const url = new URL(preset.baseUrl);
      expect(url.protocol).toBe("https:");
      expect(preset.baseUrl).toBe(url.origin);
    }
  });

  it("routes each preset's saved URL to the sign-in flow written for it", () => {
    const flowFor = (baseUrl: string) => createSSOFlow({ baseUrl } as AppConfig);

    expect(flowFor(SCHOOL_PRESETS.western.baseUrl)).toBeInstanceOf(WesternSSOFlow);
    expect(flowFor(SCHOOL_PRESETS.suny.baseUrl)).toBeInstanceOf(SunySSOFlow);
    expect(flowFor(SCHOOL_PRESETS.purdue.baseUrl)).toBeInstanceOf(PurdueSSOFlow);
  });

  it("asks for a campus only where several campuses share one site", () => {
    expect(SCHOOL_PRESETS.suny.campusPrompt).toBeTruthy();
    expect(SCHOOL_PRESETS.western.campusPrompt).toBeUndefined();
    expect(SCHOOL_PRESETS.purdue.campusPrompt).toBeUndefined();
  });
});

describe("saved settings on a repeat run", () => {
  const answers = {
    baseUrl: "https://mylearning.suny.edu",
    username: "abc123@sunypoly.edu",
    password: "new-password",
    headless: true,
  };

  it("keeps settings the wizard never asks about", () => {
    const existing = {
      baseUrl: "https://mylearning.suny.edu",
      username: "abc123@sunypoly.edu",
      campus: "SUNY Poly",
      excludeCourses: [1234],
      activeOnly: false,
      sessionDir: "~/custom-session",
      tokenTtl: 900,
      headless: false,
    };

    expect(buildConfigToSave(existing, answers)).toEqual({
      ...existing,
      password: "new-password",
      headless: true,
    });
  });

  it("takes a newly answered campus over the stored one", () => {
    const saved = buildConfigToSave(
      { baseUrl: answers.baseUrl, campus: "SUNY Poly" },
      { ...answers, campus: "SUNY Oswego" },
    );
    expect(saved.campus).toBe("SUNY Oswego");
  });

  it("never carries a v1 plaintext password over the one just typed", () => {
    const saved = buildConfigToSave(
      { baseUrl: answers.baseUrl, password: "old-v1-password" },
      answers,
    );
    expect(saved.password).toBe("new-password");
  });

  it("starts clean when the school changes", () => {
    const saved = buildConfigToSave(
      { baseUrl: "https://purdue.brightspace.com", campus: "Purdue West Lafayette", excludeCourses: [7] },
      answers,
    );
    expect(saved).toEqual({ ...answers, password: "new-password" });
    expect(saved.campus).toBeUndefined();
    expect(saved.excludeCourses).toBeUndefined();
  });

  it("keeps settings from a config that never recorded a school", () => {
    const saved = buildConfigToSave({ excludeCourses: [7], activeOnly: false }, answers);
    expect(saved.excludeCourses).toEqual([7]);
    expect(saved.activeOnly).toBe(false);
  });

  it("writes just the answers when there is nothing saved yet", () => {
    expect(buildConfigToSave(null, { ...answers, campus: "SUNY Poly" })).toEqual({
      ...answers,
      campus: "SUNY Poly",
    });
  });
});

describe("client configuration", () => {
  const brightspaceEntry = process.platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", "brightspace-mcp-server@latest"] }
    : { command: "npx", args: ["-y", "brightspace-mcp-server@latest"] };

  it("merges into an existing config without disturbing other servers", () => {
    fs.writeFileSync(configPath, JSON.stringify({
      globalShortcut: "Alt+Space",
      mcpServers: { filesystem: { command: "npx", args: ["-y", "@mcp/filesystem"] } },
    }));

    configureMcpClient(configPath);

    const written = readConfig();
    expect(written.globalShortcut).toBe("Alt+Space");
    expect(written.mcpServers.filesystem).toEqual({ command: "npx", args: ["-y", "@mcp/filesystem"] });
    expect(written.mcpServers.brightspace).toEqual(brightspaceEntry);
  });

  it("creates the file and its directory when the client has no config yet", () => {
    const nested = path.join(workDir, "Claude", "claude_desktop_config.json");
    configureMcpClient(nested);
    expect(JSON.parse(fs.readFileSync(nested, "utf-8")).mcpServers.brightspace).toEqual(brightspaceEntry);
  });

  it("reports a registration only when one was really written", () => {
    // JSON.stringify drops keys added to an array, so merging into a config
    // that is not an object used to write back "[]" and still say it worked.
    fs.writeFileSync(configPath, "[]");
    configureMcpClient(configPath);
    expect(readConfig().mcpServers.brightspace).toEqual(brightspaceEntry);

    fs.writeFileSync(configPath, "null");
    expect(() => configureMcpClient(configPath)).not.toThrow();
    expect(readConfig().mcpServers.brightspace).toEqual(brightspaceEntry);

    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: [] }));
    configureMcpClient(configPath);
    expect(readConfig().mcpServers.brightspace).toEqual(brightspaceEntry);
  });

  it("replaces an unparseable config rather than failing", () => {
    fs.writeFileSync(configPath, "{ not json");
    configureMcpClient(configPath);
    expect(readConfig().mcpServers.brightspace).toEqual(brightspaceEntry);
  });

  it("leaves the existing config untouched when the write fails", () => {
    const original = {
      mcpServers: { filesystem: { command: "npx", args: ["-y", "@mcp/filesystem"] } },
    };
    fs.writeFileSync(configPath, JSON.stringify(original, null, 2));

    fsHooks.failWrite = (target, data) => {
      // A disk that fills up mid-write: some bytes land, then the write dies.
      fs.writeFileSync(target, String(data).slice(0, 12));
      const error: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    };

    expect(() => configureMcpClient(configPath)).toThrow(/ENOSPC/);
    expect(readConfig()).toEqual(original);
  });

  it.skipIf(process.platform === "win32")("keeps the permissions the config already had", () => {
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    fs.chmodSync(configPath, 0o600);

    configureMcpClient(configPath);

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
