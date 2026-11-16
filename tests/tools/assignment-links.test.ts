import { describe, it, expect, vi } from "vitest";
import { assignmentLinkResolver } from "../../src/tools/assignment-links.js";
import { fetchCourseAssignments } from "../../src/tools/get-assignments.js";
import { registerGetAssignmentFiles } from "../../src/tools/get-assignment-files.js";
import { registerGetUpcomingDueDates } from "../../src/tools/get-upcoming-due-dates.js";
import { AuthProcessError } from "../../src/auth/auth-runner.js";

const BASE = "https://brightspace.example.edu";
function client(groups: unknown = [{ GroupId: 42, Name: "Team", Enrollments: [7] }], error?: unknown) {
  return {
    lp: (path: string) => `/lp${path}`,
    le: (course: number, path: string) => `/le/${course}${path}`,
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/users/whoami")) return { Identifier: "7" };
      if (path.includes("/groupcategories/")) { if (error) throw error; return groups; }
      if (path.endsWith("/dropbox/folders/")) return [{ Id: 55, Name: "Project", GroupTypeId: 9,
        IsHidden: false, DueDate: new Date(Date.now() + 86400000).toISOString(),
        Attachments: [{ FileId: 1, FileName: "spec.txt", Size: 4 }] }];
      return [];
    }),
    getRaw: vi.fn(async () => new Response("spec", { headers: { "Content-Type": "text/plain" } })),
  };
}

describe("assignment group links", () => {
  it("resolves only the folder category and shares its lookup across folders", async () => {
    const api = client();
    const resolve = assignmentLinkResolver(api as any, BASE, 101);
    const links = await Promise.all([resolve({ Id: 55, GroupTypeId: 9 }), resolve({ Id: 56, GroupTypeId: 9 })]);
    expect(links.map((link) => link.url)).toEqual([
      `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=55&grpid=42&ou=101`,
      `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=56&grpid=42&ou=101`,
    ]);
    expect(api.get.mock.calls.map(([path]) => path)).toEqual(["/lp/users/whoami", "/lp/101/groupcategories/9/groups/"]);
    expect(api.get.mock.calls[1]).toHaveLength(2); // membership uses the API cache TTL
  });

  it.each([
    { groups: [] },
    { groups: [{ GroupId: 1, Enrollments: [99] }] },
    { groups: [{ GroupId: 1, Enrollments: [7] }, { GroupId: 2, Enrollments: [7] }] },
  ])("uses a labeled course home when membership is absent or ambiguous (%j)", async ({ groups }) => {
    const resolve = assignmentLinkResolver(client(groups) as any, `${BASE}/`, 101);
    expect(await resolve({ Id: 55, GroupTypeId: 9 })).toMatchObject({ url: `${BASE}/d2l/home/101`, urlKind: "course-home" });
  });

  it("uses course home on denied membership or invalid non-null category", async () => {
    const api = client([], Object.assign(new Error("Forbidden"), { status: 403 }));
    const resolve = assignmentLinkResolver(api as any, BASE, 101);
    expect((await resolve({ Id: 55, GroupTypeId: 9 })).urlNote).toContain("Open Assignments");
    expect((await resolve({ Id: 56, GroupTypeId: 0 })).urlKind).toBe("course-home");
  });

  it.each([
    { label: "403", error: Object.assign(new Error("Forbidden"), { status: 403 }) },
    { label: "500", error: Object.assign(new Error("Server error"), { status: 500 }) },
    { label: "network", error: new Error("socket hang up") },
  ])("says the membership couldn't be read, not that there is no group ($label)", async ({ error }) => {
    const link = await assignmentLinkResolver(client([], error) as any, BASE, 101)({ Id: 55, GroupTypeId: 9 });
    expect(link).toMatchObject({ url: `${BASE}/d2l/home/101`, urlKind: "course-home", groupMembershipUnavailable: true });
    expect(link.urlNote).toContain("does not mean you have no group");
    expect(link.urlNote).not.toContain("did not identify a unique group");
  });

  it.each([
    { groups: [] },
    { groups: [{ GroupId: 1, Enrollments: [7] }, { GroupId: 2, Enrollments: [7] }] },
  ])("keeps the no-unique-group note when membership was read (%j)", async ({ groups }) => {
    const link = await assignmentLinkResolver(client(groups) as any, BASE, 101)({ Id: 55, GroupTypeId: 9 });
    expect(link.urlNote).toContain("did not identify a unique group");
    expect(link).not.toHaveProperty("groupMembershipUnavailable");
  });

  it("carries groupMembershipUnavailable into get_assignments rows", async () => {
    const api = client([], Object.assign(new Error("Forbidden"), { status: 403 }));
    const [assignment] = await fetchCourseAssignments(api as any, 101, BASE);
    expect(assignment).toMatchObject({ urlKind: "course-home", groupMembershipUnavailable: true });
  });

  it("does not fetch membership for known individual folders or absent base URL", async () => {
    const api = client();
    expect((await assignmentLinkResolver(api as any, BASE, 101)({ Id: 55, GroupTypeId: null })).url).toContain("grpid=0");
    expect((await assignmentLinkResolver(api as any, BASE, 101)({ Id: 56 })).url).toContain("grpid=0");
    expect(await assignmentLinkResolver(api as any, undefined, 101)({ Id: 55, GroupTypeId: 9 })).toEqual({ url: null });
    expect(api.get).not.toHaveBeenCalled();
  });

  it("marks folders with missing GroupTypeId as individual in get_assignments", async () => {
    const api = client();
    api.get.mockImplementation(async (path: string) => path.endsWith("/dropbox/folders/")
      ? [{ Id: 55, Name: "Essay", IsHidden: false }]
      : []);
    const [assignment] = await fetchCourseAssignments(api as any, 101, BASE);
    expect(assignment).toMatchObject({ isGroup: false, urlKind: "assignment" });
    expect(assignment.url).toContain("grpid=0");
  });

  it("propagates pending authentication instead of concealing it in a fallback link", async () => {
    const error = new AuthProcessError("mfaPending", "pending");
    await expect(assignmentLinkResolver(client([], error) as any, BASE, 101)({ Id: 55, GroupTypeId: 9 })).rejects.toBe(error);
  });

  it("uses the group link in assignments, file discovery, file reading, and due dates", async () => {
    const api = client();
    const [assignment] = await fetchCourseAssignments(api as any, 101, BASE);
    expect(assignment.url).toContain("grpid=42");
    let handler: any;
    const server = { registerTool: (_name: string, _meta: unknown, fn: any) => { handler = fn; } };
    registerGetAssignmentFiles(server as any, api as any, BASE);
    const discovery = JSON.parse((await handler({ courseId: 101 })).content[0].text);
    expect(discovery.assignments[0].url).toContain("grpid=42");
    const file = JSON.parse((await handler({ courseId: 101, folderId: 55, fileId: 1 })).content[0].text);
    expect(file.url).toContain("grpid=42");
    registerGetUpcomingDueDates(server as any, api as any, { baseUrl: BASE, courseFilter: { activeOnly: true } } as any);
    const due = JSON.parse((await handler({ courseId: 101 })).content[0].text);
    expect(due[0].url).toContain("grpid=42");
  });
});
