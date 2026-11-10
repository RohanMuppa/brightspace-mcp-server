import { describe, expect, it, vi } from "vitest";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";

/**
 * An embedded video (TypeIdentifier ContentService) is a topic with no file
 * behind it, so download_file cannot fetch it. It is labelled so a caller
 * does not take it for a file that is missing.
 */
const topic = (id: number, extra: Record<string, unknown>) => ({
  Id: id, Title: `Topic ${id}`, ShortTitle: null, Type: 1, Description: null, ModuleStartDate: null,
  ModuleEndDate: null, ModuleDueDate: null, IsHidden: false, IsLocked: false, LastModifiedDate: null, ...extra,
});

async function content(items: unknown[], args: Record<string, unknown> = {}) {
  const apiClient = {
    le: (id: number, p: string) => `/d2l/api/le/1.0/${id}${p}`,
    get: vi.fn(async (path: string) => (path.endsWith("/content/root/") ? items : [])),
  };
  let handler: any;
  registerGetCourseContent({ registerTool: (_n: string, _m: unknown, fn: unknown) => { handler = fn; } } as never, apiClient as never);
  const response = await handler({ courseId: 1, ...args });
  return JSON.parse(response.content[0].text).contentTree as any[];
}

describe("get_course_content embedded media", () => {
  it("marks a ContentService topic as embedded media download_file cannot fetch", async () => {
    const [video] = await content([topic(5, { TypeIdentifier: "ContentService", TopicType: 3, Url: "/d2l/lti/x" })]);
    expect(video.embeddedMedia).toBe(true);
    expect(video.note).toMatch(/download_file cannot fetch/);
  });

  it("matches the type case-insensitively", async () => {
    const [video] = await content([topic(5, { TypeIdentifier: "contentservice" })]);
    expect(video.embeddedMedia).toBe(true);
  });

  it("leaves files, links and untyped topics unmarked", async () => {
    const tree = await content([
      topic(1, { TypeIdentifier: "File", TopicType: 1, Url: "/a.pdf" }),
      topic(2, { TypeIdentifier: "Link", TopicType: 2, Url: "https://x.test" }),
      topic(3, { TopicType: 1 }),
    ]);
    for (const item of tree) {
      expect(item.embeddedMedia).toBeUndefined();
      expect(item.note).toBeUndefined();
    }
  });

  it("still reports a media link under the link filter", async () => {
    const tree = await content([topic(5, { TypeIdentifier: "ContentService", TopicType: 3, Url: "/v" })], { typeFilter: "link" });
    expect(tree[0].embeddedMedia).toBe(true);
    expect(tree[0].topicType).toBe("link");
  });
});
