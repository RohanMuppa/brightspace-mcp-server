import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  registerGetMyCourses,
  registerGetUpcomingDueDates,
  registerGetCalendarEvents,
  registerGetMyGrades,
  registerGetAnnouncements,
  registerGetAssignments,
  registerGetAssignmentFiles,
  registerGetAnnouncementFiles,
  registerGetCourseContent,
  registerDownloadFile,
  registerGetClasslistEmails,
  registerGetRoster,
  registerGetSyllabus,
  registerGetDiscussions,
  registerGetVideoTranscript,
  registerGetServerInfo,
} from "../../src/tools/index.js";
import {
  registerWeeklyBriefingPrompt,
  registerGradeAuditPrompt,
  registerStudyPlannerPrompt,
  registerCourseSummaryPrompt,
} from "../../src/prompts/index.js";

/**
 * Prompts are rendered as plain English instructions for a model to follow —
 * they are only useful if they call our tools by the name those tools are
 * actually registered under. Rather than hardcode the expected tool list
 * here (which would happily keep passing after a tool was renamed), this
 * suite stands up a real McpServer, registers the real tools the same way
 * src/index.ts does, and talks to it over a real in-memory MCP connection.
 * The tool-name list used to validate prompt text comes from the server's
 * own `tools/list` response, so renaming a tool elsewhere breaks this test.
 *
 * None of the tool registration functions touch apiClient/config at
 * registration time (only inside the request handler, which this suite
 * never invokes), so stub objects are safe here.
 */

const stubApiClient = {} as any;
const stubConfig = {
  baseUrl: "https://brightspace.example.edu",
  sessionDir: "/tmp/nope",
  tokenTtl: 3600,
  headless: true,
  courseFilter: { activeOnly: true },
} as any;

let client: Client;
let serverToolNames: string[];
let promptsList: Awaited<ReturnType<Client["listPrompts"]>>["prompts"];

beforeAll(async () => {
  const server = new McpServer(
    { name: "brightspace-test", version: "0.0.0-test" },
    { capabilities: { logging: {} } }
  );

  // Register every real tool, exactly as src/index.ts does.
  registerGetMyCourses(server, stubApiClient, stubConfig);
  registerGetUpcomingDueDates(server, stubApiClient, stubConfig);
  registerGetCalendarEvents(server, stubApiClient, stubConfig);
  registerGetMyGrades(server, stubApiClient, stubConfig);
  registerGetAnnouncements(server, stubApiClient, stubConfig);
  registerGetAssignments(server, stubApiClient, stubConfig);
  registerGetAssignmentFiles(server, stubApiClient, stubConfig.baseUrl);
  registerGetAnnouncementFiles(server, stubApiClient);
  registerGetCourseContent(server, stubApiClient);
  registerDownloadFile(server, stubApiClient);
  registerGetClasslistEmails(server, stubApiClient);
  registerGetRoster(server, stubApiClient);
  registerGetSyllabus(server, stubApiClient);
  registerGetDiscussions(server, stubApiClient);
  registerGetVideoTranscript(server, stubApiClient);
  registerGetServerInfo(server, stubConfig, "0.0.0-test");

  // Register the four new prompts, exactly as src/index.ts does.
  registerWeeklyBriefingPrompt(server);
  registerGradeAuditPrompt(server);
  registerStudyPlannerPrompt(server);
  registerCourseSummaryPrompt(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0-test" });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const { tools } = await client.listTools();
  serverToolNames = tools.map((t) => t.name);

  const listed = await client.listPrompts();
  promptsList = listed.prompts;
});

describe("server registration — prompts capability", () => {
  it("advertises the prompts capability alongside tools", () => {
    const caps = client.getServerCapabilities();
    expect(caps?.prompts).toBeDefined();
    expect(caps?.tools).toBeDefined();
  });

  it("lists exactly the four registered prompts", () => {
    const names = promptsList.map((p) => p.name).sort();
    expect(names).toEqual(
      ["course_summary", "grade_audit", "study_planner", "weekly_briefing"].sort()
    );
  });

  it("registers real tools to validate prompt text against (sanity check)", () => {
    expect(serverToolNames).toContain("get_my_courses");
    expect(serverToolNames.length).toBeGreaterThan(10);
  });

  it("reports study_planner's daysAhead as not required", () => {
    const prompt = promptsList.find((p) => p.name === "study_planner");
    const daysAhead = prompt?.arguments?.find((a) => a.name === "daysAhead");
    expect(daysAhead).toBeDefined();
    expect(daysAhead?.required).toBe(false);
  });

  it("reports grade_audit's courseId as not required", () => {
    const prompt = promptsList.find((p) => p.name === "grade_audit");
    const courseId = prompt?.arguments?.find((a) => a.name === "courseId");
    expect(courseId).toBeDefined();
    expect(courseId?.required).toBe(false);
  });
});

/** Every token in a prompt's rendered text that looks like one of our tool names. */
function mentionedToolNames(text: string): string[] {
  const matches = text.match(/\b(?:get|download)_[a-z_]+\b/g) ?? [];
  return [...new Set(matches)];
}

describe("weekly_briefing prompt", () => {
  it("renders with no arguments and mentions only real tools", async () => {
    const result = await client.getPrompt({ name: "weekly_briefing", arguments: {} });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    const text = (result.messages[0].content as { text: string }).text;
    const mentioned = mentionedToolNames(text);
    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of mentioned) {
      expect(serverToolNames).toContain(name);
    }
  });

  it("renders when the request omits the arguments field entirely", async () => {
    // Some MCP clients omit `arguments` rather than sending `{}` for a
    // zero-argument prompt. weekly_briefing has no argsSchema at all, so the
    // SDK takes its no-args path and never validates `arguments` — this must
    // not throw.
    const result = await client.getPrompt({ name: "weekly_briefing" });
    expect(result.messages).toHaveLength(1);
    const text = (result.messages[0].content as { text: string }).text;
    expect(mentionedToolNames(text).length).toBeGreaterThan(0);
  });
});

describe("grade_audit prompt", () => {
  it("renders for all courses when courseId is omitted", async () => {
    const result = await client.getPrompt({ name: "grade_audit", arguments: {} });
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toMatch(/every enrolled course/i);
    for (const name of mentionedToolNames(text)) {
      expect(serverToolNames).toContain(name);
    }
  });

  it("renders for a single course when courseId is given", async () => {
    const result = await client.getPrompt({
      name: "grade_audit",
      arguments: { courseId: "12345" },
    });
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("12345");
    for (const name of mentionedToolNames(text)) {
      expect(serverToolNames).toContain(name);
    }
  });

  it("rejects a non-numeric courseId", async () => {
    await expect(
      client.getPrompt({ name: "grade_audit", arguments: { courseId: "not-a-number" } })
    ).rejects.toThrow();
  });
});

describe("study_planner prompt", () => {
  it("defaults daysAhead to 7 when omitted", async () => {
    const result = await client.getPrompt({ name: "study_planner", arguments: {} });
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("7 days");
    for (const name of mentionedToolNames(text)) {
      expect(serverToolNames).toContain(name);
    }
  });

  it("honors an explicit daysAhead", async () => {
    const result = await client.getPrompt({
      name: "study_planner",
      arguments: { daysAhead: "14" },
    });
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("14 days");
  });

  it("rejects a daysAhead outside the allowed range", async () => {
    await expect(
      client.getPrompt({ name: "study_planner", arguments: { daysAhead: "999" } })
    ).rejects.toThrow();
  });

  it("rejects a non-numeric daysAhead", async () => {
    await expect(
      client.getPrompt({ name: "study_planner", arguments: { daysAhead: "soon" } })
    ).rejects.toThrow();
  });

  it("rejects (via the SDK's own argument validation, not a callback crash) a " +
    "request that omits the arguments field entirely", async () => {
    // study_planner (unlike weekly_briefing) still declares `daysAhead` via
    // argsSchema so it shows up, correctly marked optional, in prompts/list.
    // That keeps the SDK's own `arguments` validation in play for every call,
    // so a GetPrompt request omitting `arguments` entirely is rejected by the
    // SDK before our callback runs — the same as any prompt with a declared
    // argument. What the callback's `args ?? {}` guard buys us is that it can
    // never crash with a raw TypeError on `args.daysAhead` if `args` itself
    // ever arrives undefined, rather than closing this SDK-level gap.
    await expect(client.getPrompt({ name: "study_planner" })).rejects.toThrow();
  });
});

describe("course_summary prompt", () => {
  it("renders for the given course", async () => {
    const result = await client.getPrompt({
      name: "course_summary",
      arguments: { courseId: "54321" },
    });
    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain("54321");
    for (const name of mentionedToolNames(text)) {
      expect(serverToolNames).toContain(name);
    }
  });

  it("rejects a missing courseId (required)", async () => {
    await expect(
      client.getPrompt({ name: "course_summary", arguments: {} })
    ).rejects.toThrow();
  });

  it("rejects a non-numeric courseId", async () => {
    await expect(
      client.getPrompt({ name: "course_summary", arguments: { courseId: "abc" } })
    ).rejects.toThrow();
  });
});
