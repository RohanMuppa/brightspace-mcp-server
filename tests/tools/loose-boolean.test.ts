import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DownloadCourseFilesSchema } from "../../src/tools/schemas.js";
import { registerDownloadCourseFiles } from "../../src/tools/download-course-files.js";

const OPTIONS = ["includeSubmissions", "includeAssignmentFiles", "includeAnnouncementFiles", "everything", "dryRun"] as const;
const parse = (key: string, value: unknown) => DownloadCourseFilesSchema.safeParse({ courseId: 1, downloadPath: "/x", [key]: value });

describe("download_course_files boolean options", () => {
  it.each(OPTIONS)("%s accepts real booleans unchanged", (key) => {
    expect(parse(key, true)).toMatchObject({ success: true, data: { [key]: true } });
    expect(parse(key, false)).toMatchObject({ success: true, data: { [key]: false } });
  });

  it.each(OPTIONS)("%s accepts the strings true and false, any case, trimmed", (key) => {
    for (const [text, value] of [["true", true], ["false", false], [" TRUE ", true], ["False", false], ["\tfalse\n", false]] as const) {
      expect(parse(key, text)).toMatchObject({ success: true, data: { [key]: value } });
    }
  });

  it.each(OPTIONS)("%s rejects every other string with a clear message", (key) => {
    for (const text of ["yes", "1", "", "0", "no", "on", "truee", "true false"]) {
      const result = parse(key, text);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0].message).toMatch(/true or false/);
    }
  });

  it.each(OPTIONS)("%s still rejects numbers and null, and defaults to false when absent", (key) => {
    expect(parse(key, 1).success).toBe(false);
    expect(parse(key, null).success).toBe(false);
    expect(parse(key, undefined)).toMatchObject({ success: true, data: { [key]: false } });
  });

  it("advertises type boolean to clients, and a client sending the string is served", async () => {
    const server = new McpServer({ name: "loose-boolean", version: "1" });
    registerDownloadCourseFiles(server, {} as any);
    const client = new Client({ name: "loose-boolean", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      const schema = tools.find((tool) => tool.name === "download_course_files")!.inputSchema;
      for (const key of OPTIONS) {
        expect(schema.properties![key]).toMatchObject({ type: "boolean", default: false });
        expect(schema.required ?? []).not.toContain(key);
      }
      // The call gets past input validation; it then fails on the path (not on the string).
      const called = await client.callTool({ name: "download_course_files", arguments: { courseId: 1, downloadPath: "relative", everything: "true" } });
      expect(JSON.stringify(called.content)).not.toMatch(/expected boolean/);
      const bad = await client.callTool({ name: "download_course_files", arguments: { courseId: 1, downloadPath: "/x", everything: "yes" } });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toMatch(/true or false/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
