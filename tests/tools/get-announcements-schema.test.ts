import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerGetAnnouncements } from "../../src/tools/get-announcements.js";

/**
 * Issue #148: a client read get_announcements' count as an unbounded number,
 * asked for 100, and was refused by validation that caps it at 50. The cap has
 * to be in the schema the client actually receives from tools/list, and the
 * description has to say what to do when a course has more than the cap,
 * because there is no offset to page with.
 */

let countSchema: Record<string, unknown>;
let toolDescription: string;

beforeAll(async () => {
  const server = new McpServer({ name: "brightspace-test", version: "0.0.0-test" });
  registerGetAnnouncements(server, {} as any, { courseFilter: { activeOnly: true } } as any);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "get_announcements")!;
  countSchema = (tool.inputSchema.properties as Record<string, Record<string, unknown>>).count;
  toolDescription = tool.description ?? "";
});

describe("get_announcements exposed schema (#148)", () => {
  it("advertises the same 1..50 bounds the runtime enforces on count", () => {
    expect(countSchema.minimum).toBe(1);
    expect(countSchema.maximum).toBe(50);
  });

  it("states the cap of 50 in the count description", () => {
    expect(countSchema.description).toMatch(/\b50\b/);
  });

  it("tells the caller how to reach announcements beyond the cap", () => {
    const text = `${countSchema.description} ${toolDescription}`;
    expect(text).toMatch(/no pagination|not paginated|no offset/i);
    expect(text).toMatch(/modifiedSince/);
    expect(text).toMatch(/courseId/);
  });
});
