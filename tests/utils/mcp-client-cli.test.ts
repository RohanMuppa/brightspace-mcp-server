import { describe, expect, it, vi } from "vitest";
import {
  cliMcpClients,
  configureCliMcpClient,
  isCliAvailable,
  type CommandRunner,
} from "../../src/utils/mcp-client-cli.js";

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

describe("CLI registration", () => {
  const client = cliMcpClients("darwin")[0];

  it("detects an installed CLI", () => {
    const run = vi.fn<CommandRunner>(() => 0);
    expect(isCliAvailable(client, run)).toBe(true);
    expect(run).toHaveBeenCalledWith("codex", ["--version"], "ignore");
  });

  it("preserves an existing Brightspace registration", () => {
    const run = vi.fn<CommandRunner>(() => 0);
    expect(configureCliMcpClient(client, run)).toBe("already-configured");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("codex", client.getArgs, "ignore");
  });

  it("adds Brightspace when it is not registered", () => {
    const run = vi.fn<CommandRunner>()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(0);

    expect(configureCliMcpClient(client, run)).toBe("configured");
    expect(run).toHaveBeenNthCalledWith(2, "codex", client.addArgs, "inherit");
  });

  it("reports a failed registration", () => {
    const run = vi.fn<CommandRunner>(() => 1);
    expect(configureCliMcpClient(client, run)).toBe("failed");
  });
});
