import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import { currentMfaAnnouncer, relayMfaChallenges } from "../../src/tools/mfa-relay.js";

/**
 * Stands in for a tool whose request hits an MFA challenge: it announces the
 * challenge the way the API client's re-auth hook does, then reports whether
 * an announcer was available to it.
 */
function registerChallengedTool(server: McpServer, numberMatch: string | undefined) {
  server.registerTool(
    "challenged",
    { description: "test", inputSchema: { courseId: z.number().optional() } },
    async () => {
      const announce = currentMfaAnnouncer();
      announce?.(numberMatch);
      return { content: [{ type: "text" as const, text: announce ? "relayed" : "not relayed" }] };
    },
  );
}

describe("relayMfaChallenges", () => {
  let server: McpServer;
  let client: Client;

  async function connect(numberMatch: string | undefined) {
    server = new McpServer({ name: "test", version: "0.0.0" });
    relayMfaChallenges(server);
    registerChallengedTool(server, numberMatch);
    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }

  afterEach(async () => { await client?.close(); });

  it("sends the number to enter as a progress notification on the same tool call", async () => {
    await connect("47");
    const notices: Progress[] = [];
    await client.callTool({ name: "challenged", arguments: {} }, undefined, { onprogress: (p) => notices.push(p) });

    expect(notices.map((p) => p.message)).toEqual([
      "Open Microsoft Authenticator and enter 47 within 5 minutes. Waiting for the sign-in to finish…",
    ]);
  });

  it("tells the user to approve on their phone when the challenge has no number", async () => {
    await connect(undefined);
    const notices: Progress[] = [];
    await client.callTool({ name: "challenged", arguments: {} }, undefined, { onprogress: (p) => notices.push(p) });

    expect(notices[0]?.message).toBe(
      "Approve the sign-in request on your phone (Microsoft Authenticator or Duo). Waiting for the sign-in to finish…",
    );
  });

  it("offers no announcer to a tool call whose client cannot receive progress", async () => {
    await connect("47");
    const result = await client.callTool({ name: "challenged", arguments: {} });

    expect(result.content).toEqual([{ type: "text", text: "not relayed" }]);
  });

  it("offers no announcer outside a tool call", () => {
    expect(currentMfaAnnouncer()).toBeUndefined();
  });
});
