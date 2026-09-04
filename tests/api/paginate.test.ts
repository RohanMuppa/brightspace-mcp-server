import { describe, it, expect, vi } from "vitest";
import { fetchAllItems, fetchAllObjects } from "../../src/api/paginate.js";

/**
 * D2L hands back one page at a time and points at the next with a bookmark.
 * Three tools used to read page one, log a warning, and drop the rest. These
 * helpers follow the chain, and refuse to follow it forever: a repeated
 * bookmark or a server that never says "no more" must terminate.
 */

const FIRST = "/d2l/api/lp/1.0/enrollments/myenrollments/?orgUnitTypeId=3";

/** Records requested paths and answers each from `pages` in order. */
function makeApiClient(pages: unknown[]) {
  const requested: string[] = [];
  const apiClient = {
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return pages[Math.min(requested.length - 1, pages.length - 1)];
    }),
  };
  return { apiClient, requested };
}

const itemPage = (items: number[], bookmark?: string) => ({
  Items: items.map((n) => ({ id: n })),
  PagingInfo: { HasMoreItems: bookmark !== undefined, Bookmark: bookmark ?? "" },
});

describe("fetchAllItems", () => {
  it("returns a single page as is", async () => {
    const { apiClient, requested } = makeApiClient([itemPage([1, 2])]);

    const items = await fetchAllItems<{ id: number }>(apiClient as any, FIRST);

    expect(items.map((i) => i.id)).toEqual([1, 2]);
    expect(requested).toEqual([FIRST]);
  });

  it("concatenates three pages in order, passing the bookmark each time", async () => {
    const { apiClient, requested } = makeApiClient([
      itemPage([1], "b1"),
      itemPage([2], "b2"),
      itemPage([3]),
    ]);

    const items = await fetchAllItems<{ id: number }>(apiClient as any, FIRST, {
      ttl: 60,
    });

    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(requested).toEqual([FIRST, `${FIRST}&bookmark=b1`, `${FIRST}&bookmark=b2`]);
    expect(apiClient.get).toHaveBeenCalledWith(FIRST, { ttl: 60 });
  });

  it("starts the query string when the first path has none", async () => {
    const { apiClient, requested } = makeApiClient([itemPage([1], "b1"), itemPage([2])]);

    await fetchAllItems(apiClient as any, "/enrollments/");

    expect(requested[1]).toBe("/enrollments/?bookmark=b1");
  });

  it("stops when the server repeats a bookmark", async () => {
    const { apiClient, requested } = makeApiClient([itemPage([1], "loop")]);

    const items = await fetchAllItems<{ id: number }>(apiClient as any, FIRST);

    expect(items.map((i) => i.id)).toEqual([1, 1]);
    expect(requested).toEqual([FIRST, `${FIRST}&bookmark=loop`]);
  });

  it("stops at 200 pages when every bookmark is new", async () => {
    let n = 0;
    const apiClient = {
      get: vi.fn(async () => {
        n += 1;
        return itemPage([n], `b${n}`);
      }),
    };

    const items = await fetchAllItems<{ id: number }>(apiClient as any, FIRST);

    expect(apiClient.get).toHaveBeenCalledTimes(200);
    expect(items).toHaveLength(200);
  });
});

const objectPage = (names: string[], next?: string) => ({
  Objects: names.map((name) => ({ name })),
  Next: next ?? null,
});

describe("fetchAllObjects", () => {
  it("returns a single page as is", async () => {
    const { apiClient, requested } = makeApiClient([objectPage(["ada"])]);

    const users = await fetchAllObjects<{ name: string }>(apiClient as any, "/classlist/paged/");

    expect(users.map((u) => u.name)).toEqual(["ada"]);
    expect(requested).toEqual(["/classlist/paged/"]);
  });

  it("follows Next given as a bare bookmark", async () => {
    const { apiClient, requested } = makeApiClient([
      objectPage(["ada"], "b1"),
      objectPage(["grace"]),
    ]);

    const users = await fetchAllObjects<{ name: string }>(
      apiClient as any,
      "/classlist/paged/?roleId=109"
    );

    expect(users.map((u) => u.name)).toEqual(["ada", "grace"]);
    expect(requested[1]).toBe("/classlist/paged/?roleId=109&bookmark=b1");
  });

  it("follows Next given as an absolute URL, keeping path and query", async () => {
    const { apiClient, requested } = makeApiClient([
      objectPage(["ada"], "https://brightspace.example.edu/d2l/api/le/1.0/1/classlist/paged/?bookmark=xyz"),
      objectPage(["grace"]),
    ]);

    const users = await fetchAllObjects<{ name: string }>(apiClient as any, "/classlist/paged/");

    expect(users.map((u) => u.name)).toEqual(["ada", "grace"]);
    expect(requested[1]).toBe("/d2l/api/le/1.0/1/classlist/paged/?bookmark=xyz");
  });

  it("stops when the server repeats a Next", async () => {
    const { apiClient, requested } = makeApiClient([objectPage(["ada"], "loop")]);

    const users = await fetchAllObjects<{ name: string }>(apiClient as any, "/classlist/paged/");

    expect(users).toHaveLength(2);
    expect(requested).toHaveLength(2);
  });

  it("stops at 200 pages when every Next is new", async () => {
    let n = 0;
    const apiClient = {
      get: vi.fn(async () => {
        n += 1;
        return objectPage([`user${n}`], `b${n}`);
      }),
    };

    const users = await fetchAllObjects<{ name: string }>(apiClient as any, "/classlist/paged/");

    expect(apiClient.get).toHaveBeenCalledTimes(200);
    expect(users).toHaveLength(200);
  });
});
