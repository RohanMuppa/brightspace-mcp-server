import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectMcpClients, registerAll } from "../../src/setup/clients.js";
import { serverCommand, type CommandRunner } from "../../src/utils/mcp-client-cli.js";

/**
 * The list of AI apps the wizard asks about and `setup --prepare` registers
 * without asking. Runs against a temporary home folder and a fake CLI runner,
 * so no real app is touched.
 */

let home: string;
const silent = () => {};
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clients-"));
  // Claude Code's registration is read from here, never the real ~/.claude.json.
  process.env.CLAUDE_CONFIG_DIR = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
});

/** A machine with no CLI apps installed. */
const noCli: CommandRunner = () => ({ status: null, stdout: "" });

const desktopConfig = () => path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
const readServers = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers;

describe("detectMcpClients", () => {
  it("always lists Claude Desktop, marked detected only when its folder exists", () => {
    const [before] = detectMcpClients({ platform: "darwin", home, runCommand: noCli, warn: silent });
    expect(before).toMatchObject({ id: "claude-desktop", detected: false });

    fs.mkdirSync(path.dirname(desktopConfig()), { recursive: true });
    const [after] = detectMcpClients({ platform: "darwin", home, runCommand: noCli, warn: silent });
    expect(after.detected).toBe(true);
  });

  it("lists Cursor and Antigravity only when their folders exist", () => {
    expect(detectMcpClients({ platform: "darwin", home, runCommand: noCli, warn: silent }).map((t) => t.id))
      .toEqual(["claude-desktop"]);
    fs.mkdirSync(path.join(home, ".cursor"));
    fs.mkdirSync(path.join(home, ".gemini", "antigravity"), { recursive: true });
    expect(detectMcpClients({ platform: "darwin", home, runCommand: noCli, warn: silent }).map((t) => t.id))
      .toEqual(["claude-desktop", "cursor", "antigravity"]);
  });

  it("lists a CLI app only when its command runs", () => {
    const onlyClaude: CommandRunner = (command) => ({ status: command === "claude" ? 0 : null, stdout: "" });
    const ids = detectMcpClients({ platform: "darwin", home, runCommand: onlyClaude, warn: silent }).map((t) => t.id);
    expect(ids).toEqual(["claude-desktop", "claude-code"]);
  });
});

describe("registerAll", () => {
  const desktop = () => {
    fs.mkdirSync(path.dirname(desktopConfig()), { recursive: true });
    return detectMcpClients({ platform: "darwin", home, runCommand: noCli, warn: silent });
  };

  it("adds a missing entry, then reports it current", () => {
    expect(registerAll(desktop(), { replace: false })[0].outcome).toBe("added");
    const [command, ...args] = serverCommand();
    expect(readServers(desktopConfig()).brightspace).toEqual({ command, args });
    expect(registerAll(desktop(), { replace: false })[0].outcome).toBe("current");
  });

  it("leaves a different entry without replace, and replaces it with", () => {
    fs.mkdirSync(path.dirname(desktopConfig()), { recursive: true });
    fs.writeFileSync(desktopConfig(), JSON.stringify({ mcpServers: { brightspace: { command: "node", args: ["/old.js"] }, other: { command: "x" } } }));

    expect(registerAll(desktop(), { replace: false })[0]).toMatchObject({ outcome: "different_left", current: "node [1 argument hidden]" });
    expect(readServers(desktopConfig()).brightspace).toEqual({ command: "node", args: ["/old.js"] });

    expect(registerAll(desktop(), { replace: true })[0].outcome).toBe("replaced");
    expect(readServers(desktopConfig()).other).toEqual({ command: "x" });
  });

  it("keeps an entry that uses the shared server by URL, byte for byte, unless replace", () => {
    fs.mkdirSync(path.dirname(desktopConfig()), { recursive: true });
    const url = "http://127.0.0.1:18765/mcp";
    const original = JSON.stringify({ mcpServers: { brightspace: { url, headers: { Authorization: "Bearer secret" } } } });
    fs.writeFileSync(desktopConfig(), original);

    expect(registerAll(desktop(), { replace: false })[0]).toMatchObject({ outcome: "shared_http", url });
    expect(fs.readFileSync(desktopConfig(), "utf-8")).toBe(original);

    expect(registerAll(desktop(), { replace: true })[0].outcome).toBe("replaced");
    const [command, ...args] = serverCommand();
    expect(readServers(desktopConfig()).brightspace).toEqual({ command, args });
  });

  it("passes replace to a CLI app and reports its failure", () => {
    const calls: string[][] = [];
    const runner: CommandRunner = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "--version") return { status: command === "claude" ? 0 : null, stdout: "" };
      return { status: 1, stdout: "" };
    };
    const targets = detectMcpClients({ platform: "darwin", home, runCommand: runner, warn: silent })
      .filter((t) => t.id === "claude-code");

    const [result] = registerAll(targets, { replace: false });

    expect(result).toMatchObject({ id: "claude-code", outcome: "failed" });
    expect(calls.some((c) => c.join(" ").startsWith("claude mcp add --scope user brightspace"))).toBe(true);
  });
});
