import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * The built default command, launched the way every MCP client launches it,
 * in a throwaway home directory with a pasted (fake) access token, so it reads
 * no saved settings, no credential store, and never signs in. CI builds before
 * testing; a checkout that has not built skips this.
 */

const entry = resolve(__dirname, "..", "..", "build", "index.js");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!existsSync(entry))("brightspace-mcp-server default command (real processes)", () => {
  const homes: string[] = [];
  const clients: Client[] = [];
  const pids: number[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
    // A runtime that lost the start race can still take over once the winner
    // idles out on a slow runner, so stop whatever is published as well.
    for (const home of homes) pids.push(...runtimeStates(home).map((state) => state.pid));
    for (const pid of pids.splice(0)) {
      if (alive(pid)) process.kill(pid);
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
    }
    // A relay that was just closed, or a runtime still starting up, can take a
    // moment to exit on Windows, and until it does its folder cannot be removed.
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  });

  function runtimeStates(home: string): Array<{ pid: number }> {
    const root = join(home, "sessions", "shared-runtime");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .map((name) => join(root, name, "state.json"))
      .filter((file) => existsSync(file))
      .map((file) => JSON.parse(readFileSync(file, "utf-8")));
  }

  it("shares one runtime between clients, stops it when idle, and starts it again", async () => {
    const home = mkdtempSync(join(tmpdir(), "bs-runtime-"));
    homes.push(home);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      D2L_SESSION_DIR: join(home, "sessions"),
      D2L_BASE_URL: "https://fake-brightspace.test",
      D2L_ACCESS_TOKEN: "fake-upstream-token",
      D2L_NO_UPDATE_CHECK: "1",
      D2L_RUNTIME_IDLE_SECONDS: "3",
    };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

    const connect = async () => {
      const client = new Client({ name: "chat", version: "1" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, cwd: home, stderr: "ignore" }));
      clients.push(client);
      return client;
    };

    const chats = await Promise.all([connect(), connect()]);
    for (const list of await Promise.all(chats.map((chat) => chat.listTools()))) expect(list.tools).toHaveLength(26);

    const states = runtimeStates(home);
    expect(states).toHaveLength(1);
    const { pid } = states[0];
    pids.push(pid);
    expect(alive(pid)).toBe(true);

    // Idle: the runtime goes away by itself while the chats stay connected.
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 30_000, interval: 200 });
    expect(runtimeStates(home)).toHaveLength(0);

    // The next request starts a fresh one.
    expect((await chats[1].listTools()).tools).toHaveLength(26);
    const [restarted] = runtimeStates(home);
    pids.push(restarted.pid);
    expect(restarted.pid).not.toBe(pid);
  }, 120_000);
});
