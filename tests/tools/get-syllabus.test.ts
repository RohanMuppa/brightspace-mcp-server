import { describe, it, expect, vi } from "vitest";
import { registerGetSyllabus } from "../../src/tools/get-syllabus.js";
import { ApiError } from "../../src/api/index.js";

/**
 * A course whose syllabus lives behind an LTI tool (e.g. Simple Syllabus) has
 * an empty overview and no attachment, so get_syllabus used to answer as if
 * the course had no syllabus at all. It now names the LTI sources it found and
 * says plainly that it cannot read them.
 */

const COURSE_ID = 101;

interface Routes {
  overview?: unknown;
  toc?: unknown;
  ltiLinks?: unknown;
}

function setup(routes: Routes) {
  const respond = (value: unknown, path: string) => {
    if (value instanceof Error) throw value;
    if (value === undefined) throw new ApiError(404, path, "Not Found");
    return value;
  };
  const apiClient = {
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    leGlobal: (p: string) => `/d2l/api/le/1.0${p}`,
    get: vi.fn(async (path: string) => {
      if (path.endsWith(`/${COURSE_ID}/overview`)) return respond(routes.overview, path);
      if (path.endsWith("/content/toc")) return respond(routes.toc, path);
      if (path.endsWith(`/lti/link/${COURSE_ID}/`)) return respond(routes.ltiLinks, path);
      throw new ApiError(404, path, "Not Found");
    }),
    getRaw: vi.fn(async () => {
      throw new ApiError(404, "/overview/attachment", "Not Found");
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_n: string, _m: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };
  registerGetSyllabus(server as any, apiClient as any);
  return async () => {
    const res = await handler!({ courseId: COURSE_ID });
    return JSON.parse(res.content[0].text);
  };
}

const EMPTY_OVERVIEW = { Description: null };

function tocWith(topics: unknown[]) {
  return { Modules: [{ ModuleId: 1, Title: "Start Here", Modules: [], Topics: topics }] };
}

describe("get_syllabus external LTI syllabus sources", () => {
  it("reports an active syllabus LTI link from the course's LTI links", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: tocWith([]),
      ltiLinks: [
        {
          LtiLinkId: 7,
          Title: "Simple Syllabus",
          Url: "https://school.simplesyllabus.com/api2/lti?token=secret",
          IsVisible: true,
          Key: "consumer-key",
          PlainSecret: "shh",
        },
      ],
    });

    const result = await call();

    expect(result.externalSyllabusSources).toEqual([
      {
        title: "Simple Syllabus",
        location: "lti-link",
        url: "https://school.simplesyllabus.com/api2/lti",
      },
    ]);
  });

  it("never echoes LTI keys, secrets, or launch query parameters", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: tocWith([]),
      ltiLinks: [
        {
          LtiLinkId: 7,
          Title: "Syllabus",
          Url: "https://school.simplesyllabus.com/launch?token=secret",
          IsVisible: true,
          Key: "consumer-key",
          PlainSecret: "shh",
        },
      ],
    });

    const text = JSON.stringify(await call());

    expect(text).not.toMatch(/consumer-key|shh|token=secret/);
  });

  it("skips LTI links that are hidden", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: tocWith([]),
      ltiLinks: [{ LtiLinkId: 7, Title: "Syllabus", Url: "https://x.example/lti", IsVisible: false }],
    });

    const result = await call();

    expect(result.externalSyllabusSources).toBeUndefined();
  });

  it("skips LTI links unrelated to the syllabus", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: tocWith([]),
      ltiLinks: [{ LtiLinkId: 8, Title: "Gradescope", Url: "https://www.gradescope.com/lti", IsVisible: true }],
    });

    const result = await call();

    expect(result.externalSyllabusSources).toBeUndefined();
  });

  it("reports a syllabus LTI topic found in course content", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: {
        Modules: [
          {
            ModuleId: 1,
            Title: "Course Info",
            Topics: [],
            Modules: [
              {
                ModuleId: 2,
                Title: "Policies",
                Modules: [],
                Topics: [
                  {
                    TopicId: 9,
                    Title: "Course Syllabus",
                    TypeIdentifier: "Link",
                    Url: "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=ABC-1",
                  },
                ],
              },
            ],
          },
        ],
      },
      ltiLinks: new ApiError(403, "/lti/link/101/", "Forbidden"),
    });

    const result = await call();

    expect(result.externalSyllabusSources).toEqual([
      {
        title: "Course Syllabus",
        location: "content",
        url: "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=ABC-1",
      },
    ]);
  });

  it("ignores syllabus-titled content that is not an LTI launch", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: tocWith([
        { TopicId: 3, Title: "Syllabus.pdf", TypeIdentifier: "File", Url: "/content/enforced/101/Syllabus.pdf" },
      ]),
      ltiLinks: [],
    });

    const result = await call();

    expect(result.externalSyllabusSources).toBeUndefined();
  });

  it("explains that an external syllabus source cannot be read by the server", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: tocWith([]),
      ltiLinks: [{ LtiLinkId: 7, Title: "Simple Syllabus", Url: "https://s.example/lti", IsVisible: true }],
    });

    const result = await call();

    expect(result.externalSyllabusNote).toMatch(/LTI/);
  });

  it("reports LTI sources even when the course has no overview at all", async () => {
    const call = setup({
      overview: undefined,
      toc: tocWith([]),
      ltiLinks: [{ LtiLinkId: 7, Title: "Simple Syllabus", Url: "https://s.example/lti", IsVisible: true }],
    });

    const result = await call();

    expect(result.externalSyllabusSources).toHaveLength(1);
  });

  it("still returns the overview when both LTI lookups fail", async () => {
    const call = setup({
      overview: { Description: { Text: "Welcome", Html: "<p>Welcome</p>" } },
      toc: new ApiError(403, "/content/toc", "Forbidden"),
      ltiLinks: new ApiError(403, "/lti/link/101/", "Forbidden"),
    });

    const result = await call();

    expect(result.description).toContain("Welcome");
  });
});
