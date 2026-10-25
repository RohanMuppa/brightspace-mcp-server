import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, createRuntime } from "../../src/server.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * A credential pasted into the environment that Brightspace rejects has no
 * browser sign-in behind it, so the tool's answer must say to paste a fresh
 * one, not to run the auth command. Real server and SDK client; Brightspace
 * is a stubbed fetch that refuses every API call with 401.
 */

const BASE_URL = "https://fake-brightspace.test";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const enrollment = (id: number) => ({
  OrgUnit: { Id: id, Name: `Course ${id}`, Code: `C${id}`, Type: { Id: 3, Code: "Course Offering", Name: "Course Offering" } },
  Access: { ClasslistRoleName: "Student", IsActive: true, CanAccess: true, StartDate: null, EndDate: null, LastAccessed: null },
});

const COOKIE = { envSessionCookie: "d2lSessionVal=aaa; d2lSecureSessionVal=bbb" };

describe("a rejected pasted credential", () => {
  const realFetch = globalThis.fetch;
  let sessionDir: string;
  let client: Client | undefined;
  /** When true, enrollments answer and only the per-course routes refuse: the credential expired mid-call. */
  let enrollmentsAnswer: boolean;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "bs-env-expired-"));
    enrollmentsAnswer = false;
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(BASE_URL)) return realFetch(input, init);
      if (url === `${BASE_URL}/d2l/api/versions/`) {
        return json([{ ProductCode: "lp", LatestVersion: "1.56" }, { ProductCode: "le", LatestVersion: "1.91" }]);
      }
      if (enrollmentsAnswer && url.includes("/enrollments/myenrollments/")) {
        return json({ Items: [enrollment(101), enrollment(102)], PagingInfo: { HasMoreItems: false, Bookmark: null } });
      }
      return json({ Message: "unauthorized" }, 401);
    }) as typeof fetch);
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    client = undefined;
    vi.unstubAllGlobals();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  async function ask(env: Partial<AppConfig>, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
    const config: AppConfig = { baseUrl: BASE_URL, sessionDir, tokenTtl: 3600, headless: true, courseFilter: { activeOnly: true }, ...env };
    const server = createMcpServer(createRuntime(config, "test"));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "chat", version: "1" });
    await client.connect(clientSide);
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ text?: string }>;
    return { isError: Boolean(result.isError), text: content.map((block) => block.text ?? "").join("\n") };
  }

  it("tells the user to paste a fresh D2L_SESSION_COOKIE", async () => {
    const answer = await ask(COOKIE, "get_my_courses");
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("The pasted D2L_SESSION_COOKIE has expired");
    expect(answer.text).not.toContain("in your terminal");
  });

  it("tells the user to issue a fresh D2L_ACCESS_TOKEN", async () => {
    const answer = await ask({ envAccessToken: "stale-token" }, "get_my_courses");
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("D2L_ACCESS_TOKEN was rejected by Brightspace");
    expect(answer.text).not.toContain("in your terminal");
  });

  // These tools report a pending sign-in as a partial result. A rejected
  // pasted credential is not pending: waiting never fixes it.
  it.each(["get_my_grades", "get_announcements", "get_assignments", "get_roster"])(
    "%s for one course fails with the paste-a-fresh-one guidance, not a pending sign-in",
    async (name) => {
      const answer = await ask(COOKIE, name, { courseId: 101 });
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain("The pasted D2L_SESSION_COOKIE has expired");
      expect(answer.text).not.toContain("still in progress");
    },
  );

  it.each(["get_my_grades", "get_announcements", "get_assignments", "get_calendar_events", "get_upcoming_due_dates"])(
    "%s across courses fails with the guidance when the credential is refused mid-call",
    async (name) => {
      enrollmentsAnswer = true;
      const answer = await ask(COOKIE, name);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain("The pasted D2L_SESSION_COOKIE has expired");
      expect(answer.text).not.toContain("still in progress");
    },
  );
});
