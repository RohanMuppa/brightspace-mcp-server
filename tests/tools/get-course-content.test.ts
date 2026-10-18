import { describe, it, expect, vi } from "vitest";
import { registerGetCourseContent } from "../../src/tools/get-course-content.js";
import { flattenContentTree, rankEntries } from "../../src/tools/search-course.js";

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

/**
 * /content/root/ already embeds each module's immediate children in Structure.
 * When the dedicated /structure/ call fails — a locked module, a momentary
 * 403 — the children were dropped on the floor and the module was reported as
 * empty. Under a typeFilter the module disappeared from the tree entirely,
 * because inclusion is decided by whether it has matching children.
 */

const FILE_TOPIC = {
  Id: 7,
  Title: "Lecture 1 slides",
  ShortTitle: null,
  Type: 1,
  TopicType: 1,
  Description: null,
  ModuleStartDate: null,
  ModuleEndDate: null,
  ModuleDueDate: null,
  IsHidden: false,
  IsLocked: false,
  LastModifiedDate: null,
};

const MODULE_WITH_EMBEDDED_STRUCTURE = {
  ...SELF_REFERENCING_MODULE,
  Id: 2,
  Title: "Week 1",
  Structure: [FILE_TOPIC],
};

/** Root answers with one module; its /structure/ call always fails. */
function setupBrokenStructure(rootModule: unknown) {
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/content/userprogress/")) return [];
      if (path.includes("/structure/")) {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      }
      return [rootModule];
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetCourseContent(server as any, apiClient as any);
  return { call: (args: unknown) => handler!(args) };
}

describe("get_course_content embedded structure fallback", () => {
  it("keeps the children the root listing already carried when /structure/ fails", async () => {
    const { call } = setupBrokenStructure(MODULE_WITH_EMBEDDED_STRUCTURE);

    const body = JSON.parse((await call({ courseId: COURSE_ID })).content[0].text);

    expect(body.topicCount).toBe(1);
    expect(body.contentTree[0].children[0]).toMatchObject({
      type: "topic",
      topicType: "file",
      title: "Lecture 1 slides",
    });
  });

  it("does not drop the module under a typeFilter when /structure/ fails", async () => {
    const { call } = setupBrokenStructure(MODULE_WITH_EMBEDDED_STRUCTURE);

    const body = JSON.parse(
      (await call({ courseId: COURSE_ID, typeFilter: "file" })).content[0].text
    );

    expect(body.moduleCount).toBe(1);
    expect(body.topicCount).toBe(1);
  });

  it("still reports an empty module as empty when nothing was embedded", async () => {
    const { call } = setupBrokenStructure(SELF_REFERENCING_MODULE);

    const body = JSON.parse((await call({ courseId: COURSE_ID })).content[0].text);

    expect(body.moduleCount).toBe(1);
    expect(body.contentTree[0].children).toEqual([]);
  });
});

describe("get_course_content module descriptions (#152)", () => {
  it("preserves recording links in an empty module and its searchable body without session tokens", async () => {
    const { call } = setupBrokenStructure({
      ...SELF_REFERENCING_MODULE,
      Description: {
        Text: "Recording",
        Html: '<p><a href="/d2l/common/dialogs/quickLink/quickLink.d2l?type=lti&amp;ou=101&amp;d2lSessionVal=secret">MOSFET recording</a></p>',
      },
    });
    const body = JSON.parse((await call({ courseId: COURSE_ID })).content[0].text);
    const module = body.contentTree[0];
    expect(module.children).toEqual([]);
    expect(module.description).toBe("[MOSFET recording](/d2l/common/dialogs/quickLink/quickLink.d2l?type=lti&ou=101)");
    expect(module.description).not.toContain("secret");
    const hits = rankEntries(flattenContentTree(body.contentTree), "MOSFET", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("quickLink.d2l?type=lti&ou=101");
  });

  it.each([null, { Text: "Plain description", Html: "" }, { Text: "Plain description", Html: "  " }])(
    "keeps the plain-text fallback for description %j", async (Description) => {
      const { call } = setupBrokenStructure({ ...SELF_REFERENCING_MODULE, Description });
      const body = JSON.parse((await call({ courseId: COURSE_ID })).content[0].text);
      expect(body.contentTree[0].description).toBe(Description?.Text ?? null);
    }
  );
});

describe("get_course_content courseFiles", () => {
  const link = (file: string, extra = "") =>
    `<a href="/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&amp;type=coursefile&amp;fileId=${file}${extra}">x</a>`;

  async function courseFilesFor(Html: string) {
    const { call } = setupBrokenStructure({ ...SELF_REFERENCING_MODULE, Description: { Text: "", Html } });
    const body = JSON.parse((await call({ courseId: COURSE_ID })).content[0].text);
    return body.contentTree[0].courseFiles;
  }

  it("lists the course file paths linked in a module description, once each", async () => {
    // The same file is usually linked twice: the visible link and the embedded viewer.
    const html = `<p>${link("Notes%2fLecture01.pdf")}</p><p>${link("Notes%2fLecture01.pdf")}</p><p>${link("Tutorials%2fT01.pdf")}</p>`;

    expect(await courseFilesFor(html)).toEqual(["Notes/Lecture01.pdf", "Tutorials/T01.pdf"]);
  });

  it("keeps parentheses and spaces in the file name", async () => {
    expect(await courseFilesFor(link("Notes%2fsyntax%28new-proof%29.pdf"))).toEqual(["Notes/syntax(new-proof).pdf"]);
    expect(await courseFilesFor(link("Notes%2fSlide+61+and+63.pdf"))).toEqual(["Notes/Slide 61 and 63.pdf"]);
  });

  it("ignores LTI links and links to other courses, and omits the field when there are none", async () => {
    const lti = '<a href="/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&amp;type=lti&amp;rCode=A">tool</a>';
    const other = '<a href="/d2l/common/dialogs/quickLink/quickLink.d2l?ou=999&amp;type=coursefile&amp;fileId=Notes%2fa.pdf">x</a>';

    expect(await courseFilesFor(lti + other)).toBeUndefined();
  });

  it("keeps an apostrophe in the file name, written literally or as a character reference", async () => {
    expect(await courseFilesFor(link("Notes%2fBob's%20notes.pdf"))).toEqual(["Notes/Bob's notes.pdf"]);
    expect(await courseFilesFor(link("Notes%2fBob&#39;s%20notes.pdf"))).toEqual(["Notes/Bob's notes.pdf"]);
    expect(await courseFilesFor(link("Notes%2fBob&#x27;s%20notes.pdf"))).toEqual(["Notes/Bob's notes.pdf"]);
  });

  it("keeps a double quote in a single-quoted href", async () => {
    const html = `<a href='/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&amp;type=coursefile&amp;fileId=Notes%2fthe "best" one.pdf'>x</a>`;

    expect(await courseFilesFor(html)).toEqual(['Notes/the "best" one.pdf']);
  });

  it("drops paths that parseCoursePath would refuse", async () => {
    expect(await courseFilesFor(link("..%2fsecret.pdf") + link("Notes%2fok.pdf"))).toEqual(["Notes/ok.pdf"]);
  });
});
