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
