import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PACKAGE_NAME } from "./commands.js";

export interface CliMcpClient {
  id: "codex" | "claude-code";
  displayName: string;
  command: string;
  addArgs: string[];
  removeArgs: string[];
  /**
   * The raw "brightspace" entry this client would run from any directory:
   * undefined when there is none, null when one exists but can't be read.
   */
  readEntry: (runCommand: CommandRunner) => unknown;
}

export type CommandRunner = (
  command: string,
  args: string[],
  stdio: "ignore" | "inherit" | "pipe"
) => { status: number | null; stdout: string };

/**
 * How an existing "brightspace" entry compares with the one setup writes.
 * `current` is a printable form of a different entry, so the user can see
 * what would be replaced and restore it later. `shared_http` is an entry that
 * connects by URL to the shared server (`brightspace-mcp-server http`): a
 * supported setup someone chose on purpose, not a stale one.
 */
export type Registration =
  | { state: "missing" }
  | { state: "current" }
  | { state: "shared_http"; url: string }
  | { state: "different"; current: string };

function defaultRunCommand(
  command: string,
  args: string[],
  stdio: "ignore" | "inherit" | "pipe"
): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, {
    stdio: stdio === "pipe" ? ["ignore", "pipe", "ignore"] : stdio,
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
}

/**
 * For `setup --prepare`, which an agent runs and reads as JSON: the client CLIs
 * get no stdin, so they can never stop to ask anything, and what they print
 * goes to stderr, so it can't corrupt the JSON on stdout.
 */
export const runCommandWithoutPrompts: CommandRunner = (command, args, stdio) => {
  const result = spawnSync(command, args, {
    stdio: stdio === "pipe" ? ["ignore", "pipe", "ignore"] : stdio === "inherit" ? ["ignore", 2, 2] : "ignore",
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
};

/** The command every client is registered with. */
export function serverCommand(platform: NodeJS.Platform = process.platform): string[] {
  // On Windows, npx is a .cmd shim that must be invoked through cmd.exe
  return platform === "win32"
    ? ["cmd", "/c", "npx", "-y", `${PACKAGE_NAME}@latest`]
    : ["npx", "-y", `${PACKAGE_NAME}@latest`];
}

/**
 * Whether a URL is where the shared server listens: plain http on this
 * computer, at the MCP path (see HTTP_HOST and MCP_PATH in http-server.ts,
 * which also accepts "localhost"). Any other URL is some other server.
 */
function isSharedServerUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    && parsed.pathname === "/mcp";
}

export function classifyRegistration(
  entry: unknown,
  platform: NodeJS.Platform = process.platform
): Registration {
  if (entry === undefined) return { state: "missing" };
  const unreadable: Registration = { state: "different", current: "(an entry setup could not read)" };
  if (entry === null || typeof entry !== "object") return unreadable;

  const { command, args, url } = entry as { command?: unknown; args?: unknown; url?: unknown };
  if (typeof command !== "string" && typeof url === "string") {
    // Shown without user-info, query or fragment: a token in the URL must not
    // reach the setup message or the prepare JSON (#295).
    const shown = displayUrl(url);
    if (shown === null) return unreadable;
    return isSharedServerUrl(url) ? { state: "shared_http", url: shown } : { state: "different", current: shown };
  }
  if (typeof command !== "string") {
    const transport = describeTransport(entry);
    return transport === null ? unreadable : { state: "different", current: transport };
  }
  const argv = [command, ...(Array.isArray(args) ? args.map(String) : [])];
  const expected = serverCommand(platform);
  if (argv.length === expected.length && argv.every((part, i) => part === expected[i])) {
    return { state: "current" };
  }
  return { state: "different", current: argv.join(" ") };
}

/**
 * A URL with its user-info, query and fragment removed, which is where a
 * token in a URL rides. Null when it doesn't parse.
 */
function displayUrl(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

/**
 * A commandless entry with no string `url` (Windsurf's `serverUrl`, Gemini's
 * `httpUrl`), reduced to its transport label and its cleaned URL. Everything
 * else (headers, env, credential helpers, unknown fields) can carry secrets,
 * so it never prints.
 */
function describeTransport(entry: object): string | null {
  const { type, serverUrl, httpUrl } = entry as { type?: unknown; serverUrl?: unknown; httpUrl?: unknown };
  const raw = typeof serverUrl === "string" ? serverUrl : typeof httpUrl === "string" ? httpUrl : null;
  const shown = raw === null ? null : displayUrl(raw);
  if (shown === null) return null;
  const label = typeof type === "string" && /^[\w-]+$/.test(type) ? { type } : {};
  return JSON.stringify({ ...label, url: shown });
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Codex keeps one global registry; `--json` exposes the entry's command. */
function readCodexEntry(runCommand: CommandRunner): unknown {
  const lookup = runCommand("codex", ["mcp", "get", "brightspace", "--json"], "pipe");
  if (lookup.status === 0) {
    try {
      const parsed = JSON.parse(lookup.stdout) as { transport?: unknown };
      return parsed.transport ?? null;
    } catch {
      return null;
    }
  }
  // A Codex too old for `--json` still answers the plain lookup.
  return runCommand("codex", ["mcp", "get", "brightspace"], "ignore").status === 0
    ? null
    : undefined;
}

/**
 * Claude Code's `mcp get` resolves local, then project, then user scope from
 * the current directory, so a project's `.mcp.json` can answer for a user
 * registration that doesn't exist. Setup registers at user scope, which lives
 * in the top-level `mcpServers` of `.claude.json`; read that directly.
 */
function readClaudeCodeEntry(): unknown {
  const configDir = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  const config = readJsonFile(path.join(configDir, ".claude.json")) as
    | { mcpServers?: Record<string, unknown> }
    | undefined;
  const servers = config?.mcpServers;
  return servers && typeof servers === "object" ? servers.brightspace : undefined;
}

export function cliMcpClients(platform: NodeJS.Platform = process.platform): CliMcpClient[] {
  const command = serverCommand(platform);

  return [
    {
      id: "codex",
      displayName: "Codex Desktop and CLI",
      command: "codex",
      addArgs: ["mcp", "add", "brightspace", "--", ...command],
      removeArgs: ["mcp", "remove", "brightspace"],
      readEntry: readCodexEntry,
    },
    {
      id: "claude-code",
      displayName: "Claude Code",
      command: "claude",
      addArgs: ["mcp", "add", "--scope", "user", "brightspace", "--", ...command],
      removeArgs: ["mcp", "remove", "--scope", "user", "brightspace"],
      readEntry: readClaudeCodeEntry,
    },
  ];
}

export function isCliAvailable(
  client: CliMcpClient,
  runCommand: CommandRunner = defaultRunCommand
): boolean {
  return runCommand(client.command, ["--version"], "ignore").status === 0;
}

export function inspectCliMcpClient(
  client: CliMcpClient,
  runCommand: CommandRunner = defaultRunCommand
): Registration {
  return classifyRegistration(client.readEntry(runCommand));
}

/**
 * Writes the expected entry. With `replace`, the existing one is removed
 * first, since `claude mcp add` refuses a name that is already taken.
 */
export function registerCliMcpClient(
  client: CliMcpClient,
  { replace }: { replace: boolean },
  runCommand: CommandRunner = defaultRunCommand
): boolean {
  if (replace && runCommand(client.command, client.removeArgs, "inherit").status !== 0) {
    return false;
  }
  return runCommand(client.command, client.addArgs, "inherit").status === 0;
}
