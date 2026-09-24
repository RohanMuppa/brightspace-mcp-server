import { describe, it, expect, vi } from "vitest";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";

/**
 * A module whose structure lists itself is a cycle, and with no maxDepth the
 * tree builder followed it forever. Descent now stops at a hard ceiling.
 */

const COURSE_ID = 101;

const SELF_REFERENCING_MODULE = {
  Id: 1,
  Title: "Week 1",
  ShortTitle: null,
  Type: 0,
  Description: null,
  ModuleStartDate: null,
  ModuleEndDate: null,
  ModuleDueDate: null,
  IsHidden: false,
  IsLocked: false,
  LastModifiedDate: null,
};

function setup() {
  const requested: string[] = [];
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      if (path.endsWith("/content/userprogress/")) return [];
      return [SELF_REFERENCING_MODULE];
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetCourseContent(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args), requested };
}

/**
 * The tree used to emit isHidden, isLocked, dueDate, and completedDate on
 * every node even when false/null, padding every response with fields that
 * carry no information. They should appear only when they say something.
 */
describe("get_course_content sparse flags", () => {
  function setupWithRoot(rootItems: unknown[], progress: unknown[] = []) {
    const apiClient = {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/content/userprogress/")) return progress;
        if (path.endsWith("/content/root/")) return rootItems;
        return [];
      }),
    };

    let handler: (args: unknown) => Promise<any>;
    const server = {
      registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
        handler = fn;
      },
    };

    registerGetCourseContent(server as any, apiClient as any);
    return (args: unknown) => handler!(args);
  }

  it("omits isHidden, isLocked, dueDate, and completedDate when they carry no signal", async () => {
    const call = setupWithRoot([
      {
        Id: 5,
        Title: "Syllabus",
        ShortTitle: null,
        Type: 1,
        TopicType: 1,
        Description: null,
        IsHidden: false,
        IsLocked: false,
        DueDate: null,
        LastModifiedDate: null,
      },
    ]);

    const result = await call({ courseId: COURSE_ID });
    const body = JSON.parse(result.content[0].text);
    const topic = body.contentTree[0];

    expect(topic).not.toHaveProperty("isHidden");
    expect(topic).not.toHaveProperty("isLocked");
    expect(topic).not.toHaveProperty("dueDate");
    expect(topic).not.toHaveProperty("completedDate");
  });

  it("keeps isHidden, isLocked, dueDate, and completedDate when true/set", async () => {
    const call = setupWithRoot(
      [
        {
          Id: 6,
          Title: "Locked reading",
          ShortTitle: null,
          Type: 1,
          TopicType: 1,
          Description: null,
          IsHidden: true,
          IsLocked: true,
          DueDate: "2026-10-01T00:00:00.000Z",
          LastModifiedDate: null,
        },
      ],
      [{ UserId: 1, ContentObjectId: 6, IsRead: true, DateCompleted: "2026-09-20T00:00:00.000Z" }]
    );

    const result = await call({ courseId: COURSE_ID });
    const body = JSON.parse(result.content[0].text);
    const topic = body.contentTree[0];

    expect(topic.isHidden).toBe(true);
    expect(topic.isLocked).toBe(true);
    expect(topic.dueDate).toBe("2026-10-01T00:00:00.000Z");
    expect(topic.completedDate).toBe("2026-09-20T00:00:00.000Z");
  });
});

describe("get_course_content recursion cap", () => {
  it("terminates on a self-referencing module structure", async () => {
    const { call, requested } = setup();

    const result = await call({ courseId: COURSE_ID });
    const body = JSON.parse(result.content[0].text);

    // Twelve levels of descent: the root module plus twelve nested copies.
    expect(body.moduleCount).toBe(13);
    expect(requested.filter((p) => p.includes("/structure/"))).toHaveLength(12);
  });

  it("still honours a smaller maxDepth", async () => {
    const { call, requested } = setup();

    const result = await call({ courseId: COURSE_ID, maxDepth: 2 });
    const body = JSON.parse(result.content[0].text);

    expect(body.moduleCount).toBe(3);
    expect(requested.filter((p) => p.includes("/structure/"))).toHaveLength(2);
  });
});

describe("get_course_content modifiedSince (#34)", () => {
  const CUTOFF = "2026-09-15T00:00:00.000Z";
  const NEW = "2026-09-20T00:00:00.000Z";
  const OLD = "2026-01-01T00:00:00.000Z";

  const module = (id: number, lastModified: string | null) => ({
    Id: id,
    Title: `Module ${id}`,
    ShortTitle: null,
    Type: 0,
    Description: null,
    ModuleStartDate: null,
    ModuleEndDate: null,
    ModuleDueDate: null,
    IsHidden: false,
    IsLocked: false,
    LastModifiedDate: lastModified,
  });

  const topic = (id: number, lastModified: string | null) => ({
    Id: id,
    Title: `Topic ${id}`,
    ShortTitle: null,
    Type: 1,
    TopicType: 1,
    Description: null,
    ModuleStartDate: null,
    ModuleEndDate: null,
    ModuleDueDate: null,
    IsHidden: false,
    IsLocked: false,
    LastModifiedDate: lastModified,
  });

  /**
   * Module A: an old module containing one new topic and one old topic.
   * Module B: a newly-touched module containing one topic with no timestamp.
   */
  function setupTree() {
    const requested: string[] = [];
    const apiClient = {
      le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
      get: vi.fn(async (path: string) => {
        requested.push(path);
        if (path.endsWith("/content/userprogress/")) return [];
        if (path.endsWith("/content/root/")) return [module(10, OLD), module(20, NEW)];
        if (path.includes("/content/modules/10/structure/")) {
          return [topic(1, NEW), topic(2, OLD)];
        }
        if (path.includes("/content/modules/20/structure/")) {
          return [topic(3, null)];
        }
        return [];
      }),
    };

    let handler: (args: unknown) => Promise<any>;
    const server = {
      registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
        handler = fn;
      },
    };

    registerGetCourseContent(server as any, apiClient as any);
    return { call: (args: unknown) => handler!(args), requested };
  }

  it("emits lastModified on modules and topics", async () => {
    const { call } = setupTree();
    const result = await call({ courseId: COURSE_ID });
    const body = JSON.parse(result.content[0].text);

    const moduleA = body.contentTree.find((m: any) => m.id === 10);
    expect(moduleA.lastModified).toBe(OLD);
    expect(moduleA.children.find((t: any) => t.id === 1).lastModified).toBe(NEW);
  });

  it("keeps only topics at or after modifiedSince, dropping the rest", async () => {
    const { call } = setupTree();
    const result = await call({ courseId: COURSE_ID, modifiedSince: CUTOFF });
    const body = JSON.parse(result.content[0].text);

    const moduleA = body.contentTree.find((m: any) => m.id === 10);
    expect(moduleA.children.map((t: any) => t.id)).toEqual([1]);
  });

  it("retains a module whose own timestamp matches even if no child matched on its own merits", async () => {
    const { call } = setupTree();
    const result = await call({ courseId: COURSE_ID, modifiedSince: CUTOFF });
    const body = JSON.parse(result.content[0].text);

    const moduleB = body.contentTree.find((m: any) => m.id === 20);
    expect(moduleB).toBeDefined();
  });

  it("includes a topic with a null timestamp rather than silently dropping it", async () => {
    const { call } = setupTree();
    const result = await call({ courseId: COURSE_ID, modifiedSince: CUTOFF });
    const body = JSON.parse(result.content[0].text);

    const moduleB = body.contentTree.find((m: any) => m.id === 20);
    expect(moduleB.children.map((t: any) => t.id)).toEqual([3]);
  });

  it("reports returned and filteredOut counts alongside the echoed modifiedSince", async () => {
    const { call } = setupTree();
    const result = await call({ courseId: COURSE_ID, modifiedSince: CUTOFF });
    const body = JSON.parse(result.content[0].text);

    // Topic 2 (old, under module A) is the only one filtered out.
    expect(body.modifiedSince).toBe(CUTOFF);
    expect(body.returned).toBe(2);
    expect(body.filteredOut).toBe(1);
  });

  it("omits the filter summary entirely when modifiedSince is not passed", async () => {
    const { call } = setupTree();
    const result = await call({ courseId: COURSE_ID });
    const body = JSON.parse(result.content[0].text);

    expect(body).not.toHaveProperty("modifiedSince");
    expect(body).not.toHaveProperty("filteredOut");
  });

  it("rejects a malformed modifiedSince with a validation error naming the expected format", async () => {
    const { call } = setupTree();
    const result = await call({ courseId: COURSE_ID, modifiedSince: "not-a-date" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/modifiedSince/);
    expect(result.content[0].text).toMatch(/ISO 8601/);
  });
});
