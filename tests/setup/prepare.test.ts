import { describe, expect, it, vi } from "vitest";
import { runPrepare, formatPrepare, type PrepareDeps } from "../../src/setup/prepare.js";
import { parseSetupArgs, type SetupArgs } from "../../src/setup/args.js";
import type { McpClientTarget } from "../../src/setup/clients.js";
import type { ChromiumStatus } from "../../src/utils/browser-install.js";
import type { ConfigStoreData } from "../../src/utils/config-store.js";
import type { Registration } from "../../src/utils/mcp-client-cli.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getStoredPassword, getStoredTotpUri } from "../../src/auth/credential-store.js";
import { accountSessionDirectory } from "../../src/utils/config.js";
import { MemoryCredentialBackend } from "../auth/secure-store-fixtures.js";

/**
 * `setup --prepare` is what an AI agent runs before handing over to the
 * person (issue #258). It must finish without anyone at the keyboard: no
 * stdin, no password, no sign-in. Every dependency is injected, so these
 * tests touch no real keychain, browser, network, or AI app.
 */

const PURDUE = "https://purdue.brightspace.com";

function args(...flags: string[]): SetupArgs {
  const parsed = parseSetupArgs(["node", "setup.js", "--prepare", ...flags]);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.args;
}

function app(name: string, initial: Registration, detected = true) {
  let state = initial;
  const writes: boolean[] = [];
  const target: McpClientTarget = {
    id: "claude-code",
    name,
    detected,
    question: "",
    inspect: () => state,
    write: (replace) => {
      writes.push(replace);
      state = { state: "current" };
      return true;
    },
  };
  return { target, writes };
}

interface Harness {
  existing?: ConfigStoreData | null;
  browser?: ChromiumStatus;
  browserAfterInstall?: ChromiumStatus;
  installOk?: boolean;
  networkUp?: boolean;
  signedIn?: boolean;
  targets?: McpClientTarget[];
}

function harness(options: Harness = {}) {
  let stored: ConfigStoreData | null = options.existing ?? null;
  const saves: ConfigStoreData[] = [];
  let browser = options.browser ?? { headless: "present", visible: true };
  const installs: number[] = [];
  const deps: Partial<PrepareDeps> = {
    nodeVersion: "v22.1.0",
    platform: "darwin",
    env: {},
    readExistingConfig: () => (stored ? { ...stored } : null),
    saveSecureConfig: async (config) => {
      saves.push(config);
      stored = { ...config };
    },
    configPath: () => "/home/test/.brightspace-mcp/config.json",
    probeCredentialStore: () => ({ ok: true, line: "Passwords will be kept in the macOS Keychain" }),
    discoverVersions: async () => {
      if (options.networkUp === false) throw new Error("ENOTFOUND");
      return {};
    },
    chromiumStatus: async () => browser,
    installChromium: async () => {
      installs.push(1);
      if (options.installOk === false) return { ok: false, message: "download failed" };
      browser = options.browserAfterInstall ?? { headless: "present", visible: true };
      return { ok: true };
    },
    detectClients: () => options.targets ?? [],
    getSessionToken: async () =>
      options.signedIn ? { accessToken: "t", capturedAt: 0, expiresAt: 0, source: "cache" as const } : null,
    progress: () => {},
  };
  return { deps, saves, installs, stored: () => stored };
}

describe("setup --prepare", () => {
  it("gets a fresh install ready for sign-in without saving a password", async () => {
    const code = app("Claude Code", { state: "missing" });
    const { deps, saves } = harness({ targets: [code.target] });

    const result = await runPrepare(args("--purdue", "--username", "alice"), deps);

    expect(result.state).toBe("ready_for_sign_in");
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ baseUrl: PURDUE, username: "alice", headless: true });
    expect("password" in saves[0]).toBe(false);
    expect(code.writes).toEqual([false]);
    expect(result.restart).toEqual(["Claude Code"]);
    expect(result.next).toMatchObject({
      command: "npx -y brightspace-mcp-server@latest setup --purdue --sign-in",
      needsHuman: true,
    });
    expect(result.next.instructions).toContain("Setup complete!");
  });

  it("never reads stdin", async () => {
    const read = vi.spyOn(process.stdin, "read");
    const on = vi.spyOn(process.stdin, "on");
    await runPrepare(args("--purdue"), harness().deps);
    expect(read).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
    read.mockRestore();
    on.mockRestore();
  });

  it("changes nothing when run a second time", async () => {
    const code = app("Claude Code", { state: "missing" });
    const h = harness({ targets: [code.target] });
    await runPrepare(args("--purdue", "--username", "alice"), h.deps);

    const again = await runPrepare(args("--purdue", "--username", "alice"), h.deps);

    expect(h.saves).toHaveLength(1);
    expect(code.writes).toHaveLength(1);
    expect(again.apps).toEqual([{ id: "claude-code", name: "Claude Code", outcome: "current" }]);
    expect(again.restart).toEqual([]);
    expect(again.steps.find((s) => s.id === "settings")?.line).toMatch(/^✓ Settings already saved/);
  });

  it("keeps saved settings it doesn't ask about", async () => {
    const h = harness({
      existing: { baseUrl: PURDUE, username: "alice", headless: false, rememberMfa: true, includeCourses: [7] },
    });

    await runPrepare(args("--purdue"), h.deps);

    expect(h.stored()).toMatchObject({ username: "alice", headless: false, rememberMfa: true, includeCourses: [7] });
  });

  it("leaves an app entry that runs something else, unless --replace", async () => {
    const left = app("Cursor", { state: "different", current: "node /old/build/index.js" });
    const result = await runPrepare(args("--purdue"), harness({ targets: [left.target] }).deps);
    expect(left.writes).toEqual([]);
    expect(result.apps[0]).toMatchObject({ outcome: "different_left", current: "node /old/build/index.js" });
    expect(result.state).toBe("ready_for_sign_in");

    const replaced = app("Cursor", { state: "different", current: "node /old/build/index.js" });
    const again = await runPrepare(args("--purdue", "--replace"), harness({ targets: [replaced.target] }).deps);
    expect(replaced.writes).toEqual([true]);
    expect(again.apps[0].outcome).toBe("replaced");
  });

  it("registers only apps that look installed", async () => {
    const missing = app("Claude Desktop", { state: "missing" }, false);
    const result = await runPrepare(args("--purdue"), harness({ targets: [missing.target] }).deps);
    expect(missing.writes).toEqual([]);
    expect(result.apps).toEqual([]);
    expect(result.steps.some((s) => s.line.includes("No supported AI app found"))).toBe(true);
  });

  it("reports an app it couldn't write to without failing the rest", async () => {
    const blocked: McpClientTarget = {
      ...app("Claude Desktop", { state: "missing" }).target,
      write: () => {
        throw new Error("EPERM: operation not permitted");
      },
    };
    const code = app("Claude Code", { state: "missing" });
    const result = await runPrepare(args("--purdue"), harness({ targets: [blocked, code.target] }).deps);
    expect(result.apps.map((a) => a.outcome)).toEqual(["failed", "added"]);
    expect(result.state).toBe("ready_for_sign_in");
  });

  it("leaves the SUNY campus for sign-in to ask", async () => {
    const result = await runPrepare(args("--suny", "--username", "abc"), harness().deps);
    expect(result.state).toBe("ready_for_sign_in");
    expect(result.steps.find((s) => s.id === "settings")?.line).toContain("sign-in will ask which campus");
    expect(result.next.command).toContain("--suny --sign-in");
  });

  it("asks for the school when none is given or saved", async () => {
    const result = await runPrepare(args(), harness().deps);
    expect(result.state).toBe("needs_input");
    expect(result.next.command).toBeUndefined();
    expect(result.next.needsHuman).toBe(true);
  });

  it("uses the saved school when no flag is given", async () => {
    const result = await runPrepare(args(), harness({ existing: { baseUrl: PURDUE, username: "alice" } }).deps);
    expect(result.school).toEqual({ baseUrl: PURDUE, name: "Purdue University" });
  });

  it("builds the sign-in command from --url for a school with no flag", async () => {
    const result = await runPrepare(args("--url", "learn.example.edu/"), harness().deps);
    expect(result.school?.baseUrl).toBe("https://learn.example.edu");
    expect(result.next.command).toBe("npx -y brightspace-mcp-server@latest setup --url https://learn.example.edu --sign-in");
  });

  it("installs a missing Chromium once, then reports it ready", async () => {
    const h = harness({ browser: { headless: "missing", visible: false } });
    const result = await runPrepare(args("--purdue"), h.deps);
    expect(h.installs).toHaveLength(1);
    expect(result.steps.find((s) => s.id === "browser")?.ok).toBe(true);
    expect(result.state).toBe("ready_for_sign_in");
  });

  it("is blocked when Chromium can't be installed", async () => {
    const h = harness({ browser: { headless: "missing", visible: false }, installOk: false });
    const result = await runPrepare(args("--purdue"), h.deps);
    expect(result.state).toBe("blocked");
    expect(result.steps.find((s) => s.id === "browser")?.line).toContain("playwright install chromium");
    expect(result.next.command).toBe("npx -y brightspace-mcp-server@latest setup --purdue --prepare");
  });

  it("skips the download with --no-browser-install", async () => {
    const h = harness({ browser: { headless: "missing", visible: false } });
    const result = await runPrepare(args("--purdue", "--no-browser-install"), h.deps);
    expect(h.installs).toEqual([]);
    expect(result.state).toBe("blocked");
  });

  it("is blocked when the school can't be reached, and leaves a working setup alone", async () => {
    const working = { baseUrl: PURDUE, username: "alice", campus: "x", rememberMfa: true, includeCourses: [7] };
    const h = harness({ networkUp: false, existing: working });
    const result = await runPrepare(args("--url", "purdue.brightspace.con"), h.deps);
    expect(result.state).toBe("blocked");
    expect(h.saves).toEqual([]);
    expect(h.stored()).toEqual(working);
    expect(result.steps.find((s) => s.id === "settings")?.line).toContain("not saved");
  });

  it("leaves a config holding a password from an older version as it is, so the only copy isn't lost", async () => {
    const legacy = { baseUrl: PURDUE, username: "alice", password: "v1secret" };
    const h = harness({ existing: legacy });
    const result = await runPrepare(args("--purdue", "--username", "alice"), h.deps);
    expect(h.saves).toEqual([]);
    expect(h.stored()).toEqual(legacy);
    expect(result.steps.find((s) => s.id === "settings")?.line).toContain("older version");
  });

  it("says the --url address is invalid rather than that no school was given", async () => {
    const result = await runPrepare(args("--url", "not a url"), harness().deps);
    expect(result.state).toBe("needs_input");
    expect(result.next.instructions).toContain("isn't a valid Brightspace address");
  });

  it("is blocked when the credential store isn't usable", async () => {
    const h = harness();
    h.deps.probeCredentialStore = () => ({ ok: false, line: "secret-tool is not installed" });
    const result = await runPrepare(args("--purdue"), h.deps);
    expect(result.state).toBe("blocked");
  });

  it("says so when a saved sign-in already works", async () => {
    const result = await runPrepare(
      args("--purdue", "--username", "alice"),
      harness({ signedIn: true, targets: [app("Claude Code", { state: "missing" }).target] }).deps,
    );
    expect(result.state).toBe("signed_in");
    expect(result.next).toMatchObject({ command: "npx -y brightspace-mcp-server@latest doctor --json", needsHuman: false });
    expect(result.next.instructions).toContain("Restart Claude Code");
  });

  it("warns when --username changes the saved account", async () => {
    const result = await runPrepare(
      args("--purdue", "--username", "bob"),
      harness({ existing: { baseUrl: PURDUE, username: "alice" } }).deps,
    );
    expect(result.steps.find((s) => s.id === "settings")?.line).toContain("was alice");
  });

  it("puts no secret in its result", async () => {
    const h = harness({ existing: { baseUrl: PURDUE, username: "alice", password: "hunter2", totpUri: "otpauth://totp/x?secret=ABC" } });
    const result = await runPrepare(args("--purdue"), h.deps);
    const text = JSON.stringify(result) + formatPrepare(result).join("\n");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("otpauth");
    expect(h.saves.every((saved) => !("password" in saved) && !("totpUri" in saved))).toBe(true);
  });
});

describe("setup --prepare on a 4.0.0 config with a mixed-case email", () => {
  const MIXED = "Student@purdue.edu";
  const hash = (name: string) => createHash("sha256").update(JSON.stringify([PURDUE, name])).digest("hex");
  const legacyKey = (prefix: string) => JSON.stringify(["brightspace-mcp-server", `${prefix}:${hash(MIXED)}`]);

  for (const flags of [["--purdue"], ["--purdue", "--username", "student@purdue.edu"]]) {
    it(`still finds the saved password, enrollment and session (${flags.join(" ")})`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "prepare-casing-"));
      try {
        const backend = new MemoryCredentialBackend();
        backend.values.set(legacyKey("password"), "dummy-password");
        backend.values.set(legacyKey("totp"), "otpauth://totp/Purdue?secret=GEZDGNBVGY3TQOJQ");
        const session = path.join(root, "accounts", hash(MIXED));
        await fs.mkdir(session, { recursive: true });
        const h = harness({ existing: { baseUrl: PURDUE, username: MIXED, headless: false } });

        await runPrepare(args(...flags), h.deps);

        const username = h.stored()?.username ?? "";
        expect(await getStoredPassword(PURDUE, username, backend)).toBe("dummy-password");
        expect(await getStoredTotpUri(PURDUE, username, backend)).not.toBeNull();
        expect(accountSessionDirectory(root, PURDUE, username)).toBe(session);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }

  it("doesn't call a recased email a new account", async () => {
    const h = harness({ existing: { baseUrl: PURDUE, username: MIXED } });
    const result = await runPrepare(args("--purdue", "--username", "student@purdue.edu"), h.deps);
    expect(result.steps.find((s) => s.id === "settings")?.line).not.toContain("starts fresh");
  });
});
