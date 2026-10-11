import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerGetAnnouncements } from "../../src/tools/get-announcements.js";

/**
 * Claude Code and Claude Desktop run tool calls in parallel only when the tool
 * says it is read-only, and one at a time otherwise. Run one at a time, a
 * batch that hits a sign-in queues behind the call that got the MFA number,
 * and the model cannot show that number until the whole queue has finished.
 * Every tool that only reads says so. The two download tools can write a file
 * to disk (downloadPath), so they do not.
 */
const WRITES_TO_DISK = new Set(["download_file", "download_dropbox_submission_file"]);
const toolsDir = path.join(process.cwd(), "src", "tools");

function registrations(): Array<{ name: string; config: string }> {
  const found: Array<{ name: string; config: string }> = [];
  for (const file of fs.readdirSync(toolsDir).filter((name) => name.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(toolsDir, file), "utf8");
    for (const match of source.matchAll(/registerTool\(\s*"([a-z_]+)",\s*\{([\s\S]*?)\n\s*\},\n/g)) {
      found.push({ name: match[1], config: match[2] });
    }
  }
  return found;
}

describe("read-only tool annotations", () => {
  it("finds every tool the server registers", () => {
    expect(registrations().length).toBe(25);
  });

  it.each(registrations().filter(({ name }) => !WRITES_TO_DISK.has(name)))("marks $name read-only", ({ config }) => {
    expect(config).toContain("readOnlyHint: true");
  });

  it.each([...WRITES_TO_DISK])("does not mark %s read-only, since it can write a file", (name) => {
    const registration = registrations().find((entry) => entry.name === name);
    expect(registration).toBeDefined();
    expect(registration!.config).not.toContain("readOnlyHint: true");
  });

  it("reaches the client in tools/list", async () => {
    const server = new McpServer({ name: "read-only-annotations", version: "1" });
    registerGetAnnouncements(server, {} as any, {} as any);
    const client = new Client({ name: "read-only-annotations", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      expect(tools.find((tool) => tool.name === "get_announcements")!.annotations).toMatchObject({ readOnlyHint: true });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
