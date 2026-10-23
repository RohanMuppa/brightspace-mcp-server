import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { AuthRunner } from "../../src/auth/auth-runner.js";
import { configureDevActivity, trackToolActivity } from "../../src/utils/dev-activity.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ log: vi.fn() }));

let root: string;
let client: Client;
let server: McpServer;
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.unstubAllEnvs();
  configureDevActivity(root);
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

it.each([false, true])("keeps tool/recovery IDs on external callbacks, including early MFA completion (%s)", async early => {
  root = mkdtempSync(join(tmpdir(), "auth-activity-"));
  vi.stubEnv("D2L_DEV_MODE", "true");
  configureDevActivity(root, { version: "5.0.11", role: "server" });
  const children: Array<ReturnType<typeof child>> = [];
  const entered: Array<() => void> = [];
  function child() {
    return Object.assign(new EventEmitter(), {
      pid: 12345, stderr: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(),
    });
  }
  vi.mocked(spawn).mockImplementation(() => {
    const current = child();
    children.push(current);
    entered.shift()?.();
    return current as never;
  });
  server = new McpServer({ name: "test", version: "1" });
  trackToolActivity(server);
  for (const name of ["first", "second"]) {
    const runner = new AuthRunner();
    server.registerTool(name, {}, async () => { await runner.run(); return { content: [] }; });
  }
  client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const firstReady = new Promise<void>(resolve => { entered.push(resolve); });
  const first = client.callTool({ name: "first" });
  await firstReady;
  const secondReady = new Promise<void>(resolve => { entered.push(resolve); });
  const second = client.callTool({ name: "second" });
  await secondReady;
  if (early) {
    children[0].stdout.write("MFA_NUMBER:42\n");
    await first;
  }
  // Emit in reverse order from the test's context, as an external event source.
  children[1].stdout.write("AUTH_PHASE:silentSso:20\n");
  children[1].emit("close", 0);
  children[0].stdout.write("AUTH_PHASE:silentSso:40\n");
  children[0].emit("close", 0);
  await Promise.all([first, second]);
  const rows = readdirSync(join(root, "dev-activity")).flatMap(file =>
    readFileSync(join(root, "dev-activity", file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  if (early) {
    expect(rows.findIndex(row => row.event === "tool_finished" && row.tool === "first"))
      .toBeLessThan(rows.findIndex(row => row.event === "recovery_finished" && row.tool === "first"));
    expect(JSON.stringify(rows)).not.toContain('"42"');
  }
  const recoveryIds = vi.mocked(spawn).mock.calls.map(call => (call[2] as any).env.D2L_DEV_RECOVERY_ID);
  expect(new Set(recoveryIds).size).toBe(2);
  for (const [index, name] of ["first", "second"].entries()) {
    const start = rows.find(row => row.event === "tool_started" && row.tool === name);
    for (const event of ["recovery_started", "auth_phase", "recovery_finished"]) {
      expect(rows.find(row => row.event === event && row.tool === name))
        .toMatchObject({ callId: start.callId, recoveryId: recoveryIds[index] });
    }
  }
});
