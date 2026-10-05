import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerGetVideoTranscript } from "../../src/tools/get-video-transcript.js";

/**
 * Some MCP clients drop JSON Schema keywords such as `maximum`, so a caller can
 * pass maxChars=250000 and only learn the limit from a validation error. The
 * advertised contract — read here from a real tools/list — must carry the limit
 * both as a keyword and in prose, and say how to page a whole transcript.
 */
let tool: any;

beforeAll(async () => {
  const server = new McpServer({ name: "brightspace-test", version: "0.0.0-test" });
  registerGetVideoTranscript(server, {} as any);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  tool = tools.find((t) => t.name === "get_video_transcript");
});

describe("get_video_transcript — advertised input schema", () => {
  it("advertises maxChars as an integer capped at 100000", () => {
    const maxChars = tool.inputSchema.properties.maxChars;
    expect(maxChars.type).toBe("integer");
    expect(maxChars.maximum).toBe(100000);
  });

  it("states the 100000 maxChars limit in the parameter description", () => {
    expect(tool.inputSchema.properties.maxChars.description).toMatch(/100,?000/);
  });

  it("explains paging to the end of a transcript via offset and nextOffset", () => {
    const { description } = tool;
    expect(description).toMatch(/nextOffset/);
    expect(description).toMatch(/until/i);
    expect(tool.inputSchema.properties.maxChars.description).toMatch(/offset/);
  });
});
