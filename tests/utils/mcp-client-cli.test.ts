import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyRegistration,
  cliMcpClients,
  inspectCliMcpClient,
  isCliAvailable,
  registerCliMcpClient,
  serverCommand,
  type CommandRunner,
} from "../../src/utils/mcp-client-cli.js";

const ok = (stdout = "") => ({ status: 0, stdout });
const fail = () => ({ status: 1, stdout: "" });
const [currentCommand, ...currentArgs] = serverCommand();

describe("cliMcpClients", () => {
  it("uses user-wide registrations for Codex and Claude Code", () => {
    const [codex, claude] = cliMcpClients("darwin");

    expect(codex.addArgs).toEqual([
      "mcp", "add", "brightspace", "--",
      "npx", "-y", "brightspace-mcp-server@latest",
    ]);
    expect(claude.addArgs).toEqual([
      "mcp", "add", "--scope", "user", "brightspace", "--",
      "npx", "-y", "brightspace-mcp-server@latest",
    ]);
  });

  it("wraps npx with cmd on Windows", () => {
    for (const client of cliMcpClients("win32")) {
      expect(client.addArgs).toContain("cmd");
      expect(client.addArgs).toContain("/c");
    }
  });
});

describe("classifyRegistration", () => {
  it("reports a missing entry", () => {
    expect(classifyRegistration(undefined, "darwin")).toEqual({ state: "missing" });
  });

  it("accepts the npx @latest entry as current", () => {
    const entry = { command: "npx", args: ["-y", "brightspace-mcp-server@latest"] };
    expect(classifyRegistration(entry, "darwin")).toEqual({ state: "current" });
  });

  it("accepts the cmd /c form as current on Windows", () => {
    const entry = { command: "cmd", args: ["/c", "npx", "-y", "brightspace-mcp-server@latest"] };
    expect(classifyRegistration(entry, "win32")).toEqual({ state: "current" });
  });

  it("describes an entry pointing at a local build", () => {
    const entry = { command: "node", args: ["/Users/me/brightspace-mcp-server/build/index.js"] };
    expect(classifyRegistration(entry, "darwin")).toEqual({
      state: "different",
      current: "node /Users/me/brightspace-mcp-server/build/index.js",
    });
  });

  it("treats an unpinned npx entry as different", () => {
    const entry = { command: "npx", args: ["-y", "brightspace-mcp-server"] };
    expect(classifyRegistration(entry, "darwin")).toEqual({
      state: "different",
      current: "npx -y brightspace-mcp-server",
    });
  });

  it("describes an entry without a command as JSON", () => {
    const entry = { type: "sse", endpoint: "http://localhost:3000/mcp" };
    expect(classifyRegistration(entry, "darwin")).toEqual({
      state: "different",
      current: '{"type":"sse","endpoint":"http://localhost:3000/mcp"}',
    });
  });

  it("recognizes a URL entry for the shared local server", () => {
    // Codex's streamable_http transport and Claude Code's http entry.
    const codex = { type: "streamable_http", url: "http://127.0.0.1:18765/mcp", bearer_token_env_var: "D2L_HTTP_TOKEN" };
    const claude = { type: "http", url: "http://localhost:18766/mcp", headers: { Authorization: "Bearer x" } };
    expect(classifyRegistration(codex, "darwin")).toEqual({ state: "shared_http", url: "http://127.0.0.1:18765/mcp" });
    expect(classifyRegistration(claude, "win32")).toEqual({ state: "shared_http", url: "http://localhost:18766/mcp" });
  });

  it("treats a URL that isn't the shared local server as different", () => {
    for (const url of ["https://example.com/mcp", "http://192.168.1.5:18765/mcp", "http://127.0.0.1:18765/other", "not a url"]) {
      expect(classifyRegistration({ url }, "darwin")).toEqual({ state: "different", current: url });
    }
  });

  it("reports an entry it could not read as different", () => {
    expect(classifyRegistration(null, "darwin").state).toBe("different");
  });
});

describe("isCliAvailable", () => {
  it("detects an installed CLI", () => {
    const run = vi.fn<CommandRunner>(() => ok());
    expect(isCliAvailable(cliMcpClients("darwin")[0], run)).toBe(true);
    expect(run).toHaveBeenCalledWith("codex", ["--version"], "ignore");
  });
});

describe("Codex registration lookup", () => {
  const codex = cliMcpClients("darwin")[0];
  const codexJson = (command: string, args: string[]) =>
    JSON.stringify({ name: "brightspace", enabled: true, transport: { type: "stdio", command, args } });

  it("recognizes the current registration", () => {
    const run: CommandRunner = () => ok(codexJson(currentCommand, currentArgs));
    expect(inspectCliMcpClient(codex, run)).toEqual({ state: "current" });
  });

  it("reports what a different registration points at", () => {
    const run: CommandRunner = () => ok(codexJson("node", ["/opt/bsp/build/index.js"]));
    expect(inspectCliMcpClient(codex, run)).toEqual({
      state: "different",
      current: "node /opt/bsp/build/index.js",
    });
  });

  it("recognizes a registration that uses the shared server by URL", () => {
    const url = "http://127.0.0.1:18765/mcp";
    const run: CommandRunner = () =>
      ok(JSON.stringify({ name: "brightspace", enabled: true, transport: { type: "streamable_http", url, bearer_token_env_var: "D2L_HTTP_TOKEN" } }));
    expect(inspectCliMcpClient(codex, run)).toEqual({ state: "shared_http", url });
  });

  it("reports a missing registration", () => {
    expect(inspectCliMcpClient(codex, () => fail())).toEqual({ state: "missing" });
  });

  it("never mistakes an entry it cannot read for a current one", () => {
    // An older Codex without `mcp get --json` still answers the plain lookup.
    const run: CommandRunner = (_command, args) => (args.includes("--json") ? fail() : ok());
    expect(inspectCliMcpClient(codex, run).state).toBe("different");
  });
});

describe("Claude Code registration lookup", () => {
  const claude = cliMcpClients("darwin")[1];
  const noCommands: CommandRunner = () => fail();
  let configDir: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bsp-claude-"));
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const writeClaudeJson = (data: unknown) =>
    fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify(data));

  it("reports what the user-scope registration points at", () => {
    writeClaudeJson({
      mcpServers: { brightspace: { type: "stdio", command: "node", args: ["/dev/bsp/build/index.js"] } },
    });
    expect(inspectCliMcpClient(claude, noCommands)).toEqual({
      state: "different",
      current: "node /dev/bsp/build/index.js",
    });
  });

  it("recognizes the current user-scope registration", () => {
    writeClaudeJson({
      mcpServers: { brightspace: { type: "stdio", command: currentCommand, args: currentArgs } },
    });
    expect(inspectCliMcpClient(claude, noCommands)).toEqual({ state: "current" });
  });

  it("does not count a project-scoped entry as the user registration", () => {
    writeClaudeJson({
      projects: {
        [process.cwd()]: {
          mcpServers: { brightspace: { command: "npx", args: ["-y", "brightspace-mcp-server@latest"] } },
        },
      },
    });
    expect(inspectCliMcpClient(claude, noCommands)).toEqual({ state: "missing" });
  });

  it("reports a missing registration when Claude Code has no config file", () => {
    expect(inspectCliMcpClient(claude, noCommands)).toEqual({ state: "missing" });
  });
});

describe("CLI registration", () => {
  const [codex, claude] = cliMcpClients("darwin");

  it("adds Brightspace when it is not registered", () => {
    const run = vi.fn<CommandRunner>(() => ok());
    expect(registerCliMcpClient(codex, { replace: false }, run)).toBe(true);
    expect(run.mock.calls.map((call) => call[1])).toEqual([codex.addArgs]);
  });

  it("removes the user-scope entry before adding the replacement", () => {
    const run = vi.fn<CommandRunner>(() => ok());
    expect(registerCliMcpClient(claude, { replace: true }, run)).toBe(true);
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ["mcp", "remove", "--scope", "user", "brightspace"],
      claude.addArgs,
    ]);
  });

  it("reports a failed registration", () => {
    expect(registerCliMcpClient(codex, { replace: false }, () => fail())).toBe(false);
  });
});
