import { spawnSync } from "node:child_process";
import { PACKAGE_NAME } from "./commands.js";

export interface CliMcpClient {
  id: "codex" | "claude-code";
  displayName: string;
  command: string;
  getArgs: string[];
  addArgs: string[];
}

export type CommandRunner = (
  command: string,
  args: string[],
  stdio: "ignore" | "inherit"
) => number | null;

function defaultRunCommand(
  command: string,
  args: string[],
  stdio: "ignore" | "inherit"
): number | null {
  const result = spawnSync(command, args, {
    stdio,
    shell: process.platform === "win32",
  });
  return result.error ? null : result.status;
}

export function cliMcpClients(platform: NodeJS.Platform = process.platform): CliMcpClient[] {
  const serverCommand = platform === "win32"
    ? ["cmd", "/c", "npx", "-y", `${PACKAGE_NAME}@latest`]
    : ["npx", "-y", `${PACKAGE_NAME}@latest`];

  return [
    {
      id: "codex",
      displayName: "Codex Desktop and CLI",
      command: "codex",
      getArgs: ["mcp", "get", "brightspace"],
      addArgs: ["mcp", "add", "brightspace", "--", ...serverCommand],
    },
    {
      id: "claude-code",
      displayName: "Claude Code",
      command: "claude",
      getArgs: ["mcp", "get", "brightspace"],
      addArgs: ["mcp", "add", "--scope", "user", "brightspace", "--", ...serverCommand],
    },
  ];
}

export function isCliAvailable(
  client: CliMcpClient,
  runCommand: CommandRunner = defaultRunCommand
): boolean {
  return runCommand(client.command, ["--version"], "ignore") === 0;
}

export function configureCliMcpClient(
  client: CliMcpClient,
  runCommand: CommandRunner = defaultRunCommand
): "configured" | "already-configured" | "failed" {
  if (runCommand(client.command, client.getArgs, "ignore") === 0) {
    return "already-configured";
  }

  return runCommand(client.command, client.addArgs, "inherit") === 0
    ? "configured"
    : "failed";
}
