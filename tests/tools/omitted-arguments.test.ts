import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { acceptOmittedArguments } from "../../src/tools/omitted-arguments.js";
import { registerGetServerInfo } from "../../src/tools/get-server-info.js";
import { registerSignOut } from "../../src/tools/sign-out.js";

/**
 * MCP lets a client leave `arguments` off a tools/call (and a prompts/get)
 * entirely. SDK 1.26 through 1.31 validate the missing value as-is, so every
 * tool whose inputs are all optional (get_server_info, sign_out,
 * get_my_courses, ...) answered such a call with "Input validation error:
 * expected object, received undefined"; SDK 1.32 reads it as `{}`. This
 * server declares ^1.26.0, so it supplies the `{}` itself.
 */

let client: Client | undefined;
let server: McpServer | undefined;

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = server = undefined;
});

async function connect(register: (server: McpServer) => void, wrap = true) {
  server = new McpServer({ name: "omitted-arguments-test", version: "1" });
  if (wrap) acceptOmittedArguments(server);
  register(server);
  client = new Client({ name: "omitted-arguments-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const firstText = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;

describe("acceptOmittedArguments", () => {
  it("answers a tools/call with no arguments for a tool that takes none", async () => {
    const c = await connect((s) =>
      s.registerTool("ping", { inputSchema: z.object({}) }, async () => ({
        content: [{ type: "text" as const, text: "pong" }],
      })),
    );
    const result = await c.callTool({ name: "ping" });
    expect(result.isError).not.toBe(true);
    expect(firstText(result)).toBe("pong");
  });

  it("answers a tools/call with no arguments for a tool whose inputs are all optional", async () => {
    const c = await connect((s) =>
      s.registerTool(
        "all_optional",
        { inputSchema: z.object({ limit: z.number().optional() }) },
        async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(args) }] }),
      ),
    );
    expect(firstText(await c.callTool({ name: "all_optional" }))).toBe("{}");
  });

  it("answers the real no-argument tools when the client omits arguments", async () => {
    const c = await connect((s) => {
      registerGetServerInfo(s, {} as never, "1.0.0", { stats: () => ({}) } as never, async () => null);
      registerSignOut(s, { envAccessToken: "pasted" } as never, { clearCache() {} }, { forgetSession() {} });
    });
    const info = await c.callTool({ name: "get_server_info" });
    expect(info.isError).not.toBe(true);
    expect(firstText(info)).not.toMatch(/Input validation error/);
    const signOut = await c.callTool({ name: "sign_out" });
    expect(firstText(signOut)).toMatch(/^Nothing was signed out/);
  });

  it("still passes arguments the client did send through untouched", async () => {
    const c = await connect((s) =>
      s.registerTool("echo", { inputSchema: z.object({ word: z.string() }) }, async ({ word }) => ({
        content: [{ type: "text" as const, text: word }],
      })),
    );
    expect(firstText(await c.callTool({ name: "echo", arguments: { word: "hi" } }))).toBe("hi");
  });

  it("still rejects an omitted arguments object when the tool has a required field", async () => {
    const c = await connect((s) =>
      s.registerTool("needs_word", { inputSchema: z.object({ word: z.string() }) }, async ({ word }) => ({
        content: [{ type: "text" as const, text: word }],
      })),
    );
    const outcome = await c.callTool({ name: "needs_word" }).then(
      (result) => (result.isError ? firstText(result) : "accepted"),
      (error: unknown) => String(error),
    );
    expect(outcome).toMatch(/word/);
    expect(outcome).not.toBe("accepted");
  });

  it("serves a prompt with declared optional arguments when the client omits them", async () => {
    const c = await connect((s) =>
      s.registerPrompt(
        "planner",
        { argsSchema: { days: z.coerce.number().optional() } },
        async (args) => ({
          messages: [{ role: "user" as const, content: { type: "text" as const, text: `days=${args?.days ?? 7}` } }],
        }),
      ),
    );
    const result = await c.getPrompt({ name: "planner" });
    expect((result.messages[0].content as { text: string }).text).toBe("days=7");
  });

  it("lists tools with the same schema it lists without the wrapper", async () => {
    const register = (s: McpServer) =>
      s.registerTool("lim", { inputSchema: z.object({ limit: z.number().optional() }) }, async () => ({ content: [] }));
    const plain = await (await connect(register, false)).listTools();
    await client?.close();
    await server?.close();
    const wrapped = await (await connect(register)).listTools();
    expect(wrapped.tools).toEqual(plain.tools);
  });

  it("hands the request handlers it wraps an arguments object whatever the SDK version does", async () => {
    // Version-independent: records what reaches the handler the SDK installs,
    // so this fails on any SDK if the wrapper stops filling the gap.
    const seen = new Map<unknown, unknown>();
    const fake = {
      server: {
        setRequestHandler(schema: unknown, handler: (request: any, extra: unknown) => unknown) {
          seen.set(schema, handler);
        },
      },
    } as unknown as McpServer;
    acceptOmittedArguments(fake);
    for (const schema of [CallToolRequestSchema, GetPromptRequestSchema]) {
      fake.server.setRequestHandler(schema as never, ((request: any) => request.params.arguments) as never);
      const handler = seen.get(schema) as (request: unknown, extra: unknown) => unknown;
      expect(handler({ method: "x", params: { name: "t" } }, {})).toEqual({});
      expect(handler({ method: "x", params: { name: "t", arguments: { a: 1 } } }, {})).toEqual({ a: 1 });
    }
  });

  it("leaves every other request handler alone", () => {
    const registered: unknown[] = [];
    const fake = {
      server: { setRequestHandler: (_schema: unknown, handler: unknown) => registered.push(handler) },
    } as unknown as McpServer;
    acceptOmittedArguments(fake);
    const handler = () => ({});
    fake.server.setRequestHandler({} as never, handler as never);
    expect(registered).toEqual([handler]);
  });
});


describe("server wiring", () => {
  it("installs acceptOmittedArguments before the first tool is registered", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../../src/server.ts", import.meta.url), "utf8");
    const installed = source.indexOf("acceptOmittedArguments(server);");
    const firstRegistration = source.indexOf("registerGetMyCourses(server");
    expect(installed).toBeGreaterThan(-1);
    expect(installed).toBeLessThan(firstRegistration);
  });
});
