import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * The built `brightspace-mcp-server http` process, started the way a user
 * would, in a throwaway home directory with a pasted (fake) access token, so
 * it reads no saved settings, no credential store, and never signs in. CI
 * builds before testing; a checkout that has not built skips this.
 */

const entry = resolve(__dirname, "..", "..", "build", "index.js");
const TOKEN = "p".repeat(48);

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

describe.skipIf(!existsSync(entry))("brightspace-mcp-server http (real process)", () => {
  const children: Array<{ child: ChildProcess; exited: Promise<unknown> }> = [];
  const homes: string[] = [];

  afterEach(async () => {
    // Windows will not delete a directory a live process is running in.
    for (const { child, exited } of children.splice(0)) {
      if (child.exitCode === null) child.kill();
      await exited;
    }
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function start(port: number, token: string | null = TOKEN) {
    const home = mkdtempSync(join(tmpdir(), "bs-http-"));
    homes.push(home);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      D2L_SESSION_DIR: join(home, "sessions"),
      D2L_BASE_URL: "https://fake-brightspace.test",
      D2L_ACCESS_TOKEN: "fake-upstream-token",
      D2L_NO_UPDATE_CHECK: "1",
    };
    if (token) env.D2L_HTTP_TOKEN = token;
    const child = spawn(process.execPath, [entry, "http", "--port", String(port)], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const exited = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
    children.push({ child, exited });
    const ready = new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no readiness line; stderr: ${stderr}`)), 45_000);
      child.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.includes(`listening on http://127.0.0.1:${port}/mcp`)) { clearTimeout(timer); done(); }
      });
      void exited.then((code) => { clearTimeout(timer); fail(new Error(`exited ${code}; stderr: ${stderr}`)); });
    });
    void ready.catch(() => {});
    return { child, ready, exited, stderr: () => stderr };
  }

  it("serves several clients from one process and refuses a second copy on the same port", async () => {
    const port = await freePort();
    const server = start(port);
    await server.ready;

    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const chats = [new Client({ name: "a", version: "1" }), new Client({ name: "b", version: "1" })];
    await Promise.all(chats.map((chat) => chat.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }))));
    for (const chat of chats) {
      expect((await chat.listTools()).tools).toHaveLength(26);
      expect((await chat.listPrompts()).prompts).toHaveLength(4);
    }
    await Promise.all(chats.map((chat) => chat.close()));

    const second = start(port);
    expect(await second.exited).toBe(1);
    expect(second.stderr()).toMatch(/already in use/);
    // The first is untouched and still running.
    expect(server.child.exitCode).toBeNull();
    expect(server.stderr()).not.toContain(TOKEN);
  }, 90_000);

  it("will not start without a bearer token", async () => {
    const server = start(await freePort(), null);
    expect(await server.exited).toBe(1);
    expect(server.stderr()).toMatch(/D2L_HTTP_TOKEN is not set/);
  }, 90_000);
});
