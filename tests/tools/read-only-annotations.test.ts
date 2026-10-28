import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerGetAnnouncements } from "../../src/tools/get-announcements.js";

/**
 * Claude Code runs MCP tool calls in parallel only when the tool says it is
 * read-only, and one at a time otherwise. Run one at a time, a batch that hits
 * a sign-in queues behind the call that got the MFA number, and the model
 * cannot show that number until the whole queue has finished. Every tool that
 * only reads says so. A tool that can save a file to disk (downloadPath) does
 * not: clients also use the hint to skip permission prompts.
 */
const WRITES_TO_DISK = new Set(["download_file", "download_dropbox_submission_file", "get_syllabus"]);
/**
 * The one tool that destroys state: it deletes the saved session. It is
 * neither read-only nor a file writer, and it says so with destructiveHint so
 * clients ask the user before running it.
 */
const DESTRUCTIVE = new Set(["sign_out"]);
/**
 * Changes sign-in state rather than reading Brightspace, so not read-only.
 * sign_in starts a sign-in: openWorldHint, because it reaches the school's
 * identity provider and may put a browser window on the user's screen. It is
 * not destructive — it creates a session rather than deleting one — so a
 * client has no reason to warn the user before it runs.
 */
const SIGNS_IN = new Set(["sign_in"]);
const toolsDir = path.join(process.cwd(), "src", "tools");

function registrations(): Array<{ name: string; config: string }> {
  const found: Array<{ name: string; config: string }> = [];
  for (const file of fs.readdirSync(toolsDir).filter((name) => name.endsWith(".ts"))) {
    // Normalized: a Windows checkout has CRLF line endings.
    const source = fs.readFileSync(path.join(toolsDir, file), "utf8").replace(/\r\n/g, "\n");
    for (const match of source.matchAll(/registerTool\(\s*"([a-z_]+)",\s*\{([\s\S]*?)\n\s*\},\n/g)) {
      found.push({ name: match[1], config: match[2] });
    }
  }
  return found;
}

describe("read-only tool annotations", () => {
  it("finds every tool the server registers", () => {
    expect(registrations().length).toBe(27);
  });

  it.each(registrations().filter(({ name }) => !WRITES_TO_DISK.has(name) && !DESTRUCTIVE.has(name) && !SIGNS_IN.has(name)))("marks $name read-only", ({ config }) => {
    expect(config).toContain("readOnlyHint: true");
  });

  it("leaves unmarked every tool whose source takes a downloadPath", () => {
    const files = fs.readdirSync(toolsDir).filter((name) => name.endsWith(".ts"));
    for (const file of files) {
      const source = fs.readFileSync(path.join(toolsDir, file), "utf8").replace(/\r\n/g, "\n");
      if (!source.includes("downloadPath")) continue;
      for (const match of source.matchAll(/registerTool\(\s*"([a-z_]+)"/g)) {
        expect(WRITES_TO_DISK, `${match[1]} in ${file} takes a downloadPath`).toContain(match[1]);
      }
    }
  });

  it.each([...WRITES_TO_DISK])("does not mark %s read-only, since it can write a file", (name) => {
    const registration = registrations().find((entry) => entry.name === name);
    expect(registration).toBeDefined();
    expect(registration!.config).not.toContain("readOnlyHint: true");
  });

  it.each([...SIGNS_IN])("marks %s open-world, not read-only, and not destructive", (name) => {
    const registration = registrations().find((entry) => entry.name === name);
    expect(registration).toBeDefined();
    expect(registration!.config).toContain("readOnlyHint: false");
    expect(registration!.config).toContain("openWorldHint: true");
    expect(registration!.config).toContain("destructiveHint: false");
    expect(registration!.config).not.toContain("readOnlyHint: true");
  });

  it.each([...DESTRUCTIVE])("marks %s destructive and never read-only", (name) => {
    const registration = registrations().find((entry) => entry.name === name);
    expect(registration).toBeDefined();
    expect(registration!.config).toContain("destructiveHint: true");
    expect(registration!.config).toContain("readOnlyHint: false");
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
