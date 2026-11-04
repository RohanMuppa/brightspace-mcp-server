import { describe, it, expect, vi } from "vitest";
import { registerGetClasslistEmails } from "../../src/tools/get-classlist-emails.js";

/**
 * The paged classlist points at its next page with Next. Reading only the
 * first page used to hide everyone after it behind a warning.
 */

const COURSE_ID = 101;

const user = (name: string) => ({
  Identifier: name.length,
  DisplayName: name,
  Email: `${name}@example.edu`,
  ClasslistRoleDisplayName: "Student",
});

function setup(respond: (path: string) => unknown) {
  const requested: string[] = [];
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return respond(path);
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetClasslistEmails(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), requested };
}

describe("get_classlist_emails pagination", () => {
  it("returns everyone across both pages", async () => {
    const { call, requested } = setup((path) =>
      path.includes("bookmark=b1")
        ? { Objects: [user("grace")], Next: null }
        : { Objects: [user("ada")], Next: "b1" }
    );

    const result = await call({ courseId: COURSE_ID });
    const emails = JSON.parse(result.content[0].text);

    expect(emails.map((e: { name: string }) => e.name)).toEqual(["ada", "grace"]);
    expect(requested).toHaveLength(2);
  });
});

describe("get_classlist_emails hidden emails", () => {
  const hiddenUser = (name: string) => ({ ...user(name), Email: null });

  it("lists visible emails and says how many people were left out", async () => {
    const { call } = setup(() => ({
      Objects: [user("ada"), hiddenUser("bob"), hiddenUser("cy")],
      Next: null,
    }));

    const result = await call({ courseId: COURSE_ID });
    const emails = JSON.parse(result.content[0].text);

    expect(emails.map((e: { name: string }) => e.name)).toEqual(["ada"]);
    expect(result.content[1].text).toBe(
      "2 of 3 people in this course have no email visible to you (Brightspace hides it), so they are not listed."
    );
  });

  it("does not report an all-hidden course as empty", async () => {
    const { call } = setup(() => ({ Objects: [hiddenUser("bob")], Next: null }));

    const result = await call({ courseId: COURSE_ID });

    expect(JSON.parse(result.content[0].text)).toEqual([]);
    expect(result.content[1].text).toBe(
      "1 of 1 person in this course has no email visible to you (Brightspace hides it), so they are not listed."
    );
  });

  it("adds no notice when every email is visible", async () => {
    const { call } = setup(() => ({ Objects: [user("ada")], Next: null }));

    const result = await call({ courseId: COURSE_ID });

    expect(result.content).toHaveLength(1);
  });
});
