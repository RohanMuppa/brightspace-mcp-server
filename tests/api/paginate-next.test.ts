import { describe, it, expect, vi } from "vitest";
import { fetchAllObjects } from "../../src/api/paginate.js";

/**
 * D2L returns Next in three shapes across tenants: an absolute URL, a bare
 * bookmark, and a server-relative path. The third was previously appended as
 * if it were a bookmark, which asks for a page that does not exist.
 */

function client(respond: (path: string) => unknown) {
  const requested: string[] = [];
  return {
    requested,
    apiClient: {
      get: vi.fn(async (path: string) => {
        requested.push(path);
        return respond(path);
      }),
    } as any,
  };
}

describe("fetchAllObjects Next shapes", () => {
  it("follows a server-relative Next as a path, not a bookmark", async () => {
    const { apiClient, requested } = client((path) =>
      path === "/d2l/api/lp/1.0/1/classlist/paged/?page=2"
        ? { Objects: ["b"], Next: null }
        : { Objects: ["a"], Next: "/d2l/api/lp/1.0/1/classlist/paged/?page=2" }
    );

    const all = await fetchAllObjects<string>(
      apiClient,
      "/d2l/api/lp/1.0/1/classlist/paged/"
    );

    expect(all).toEqual(["a", "b"]);
    expect(requested[1]).toBe("/d2l/api/lp/1.0/1/classlist/paged/?page=2");
    expect(requested[1]).not.toContain("bookmark=");
  });

  it("still treats a bare token as a bookmark", async () => {
    const { apiClient, requested } = client((path) =>
      path.includes("bookmark=tok2")
        ? { Objects: ["b"], Next: null }
        : { Objects: ["a"], Next: "tok2" }
    );

    const all = await fetchAllObjects<string>(apiClient, "/d2l/api/lp/1.0/1/classlist/paged/");

    expect(all).toEqual(["a", "b"]);
    expect(requested[1]).toContain("bookmark=tok2");
  });
});
