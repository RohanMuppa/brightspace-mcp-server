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

  it("strips D2L session params from a content-topic source URL but keeps its routing params (#187)", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: tocWith([
        {
          TopicId: 9,
          Title: "Course Syllabus",
          TypeIdentifier: "Link",
          Url:
            "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=fixture" +
            "&d2lSessionVal=TEST_SESSION&d2lSecureSessionVal=TEST_SECURE",
        },
      ]),
      ltiLinks: [],
    });

    const result = await call();
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("TEST_SESSION");
    expect(serialized).not.toContain("TEST_SECURE");
    expect(serialized).not.toMatch(/d2lSessionVal|d2lSecureSessionVal/i);
    expect(result.externalSyllabusSources).toEqual([
      {
        title: "Course Syllabus",
        location: "content",
        url: "/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&rcode=fixture",
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

describe("get_syllabus external discovery outcome (#188)", () => {
  const networkError = () => new TypeError("fetch failed");

  it("adds no discovery notice when both lookups succeed with nothing found", async () => {
    const call = setup({ overview: EMPTY_OVERVIEW, toc: { Modules: [] }, ltiLinks: [] });

    const result = await call();

    expect(result.externalSyllabusSources).toBeUndefined();
    expect(result.externalSyllabusNote).toBeUndefined();
    expect(result.externalSyllabusDiscovery).toBeUndefined();
  });

  it("keeps the plain 404 message when discovery succeeded empty", async () => {
    const call = setup({ overview: undefined, toc: { Modules: [] }, ltiLinks: [] });

    const result = await call();

    expect(result.message).toBe("No syllabus/overview found for this course.");
    expect(result.externalSyllabusDiscovery).toBeUndefined();
  });

  it("reports both lookups as permission-denied when they return 403", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: new ApiError(403, "/content/toc", "Forbidden: secret body"),
      ltiLinks: new ApiError(403, "/lti/link/101/", "Forbidden: secret body"),
    });

    const result = await call();

    expect(result.description).toBeNull();
    expect(result.externalSyllabusSources).toBeUndefined();
    expect(result.externalSyllabusDiscovery).toMatchObject({
      complete: false,
      unavailable: [
        { lookup: "lti-links", reason: "permission-denied", status: 403 },
        { lookup: "content-toc", reason: "permission-denied", status: 403 },
      ],
    });
    expect(result.externalSyllabusDiscovery.note).toMatch(/permission denied/);
    expect(JSON.stringify(result)).not.toContain("secret body");
  });

  it("reports transport failures distinctly from permission failures", async () => {
    const call = setup({ overview: EMPTY_OVERVIEW, toc: networkError(), ltiLinks: networkError() });

    const result = await call();

    expect(result.externalSyllabusDiscovery.unavailable).toEqual([
      { lookup: "lti-links", reason: "request-failed" },
      { lookup: "content-toc", reason: "request-failed" },
    ]);
    expect(result.externalSyllabusDiscovery.note).toMatch(/network error/);
    expect(JSON.stringify(result)).not.toContain("fetch failed");
  });

  it("does not claim the course has no syllabus when the overview 404s and discovery failed", async () => {
    const call = setup({
      overview: undefined,
      toc: new ApiError(403, "/content/toc", "Forbidden"),
      ltiLinks: networkError(),
    });

    const result = await call();

    expect(result.message).not.toBe("No syllabus/overview found for this course.");
    expect(result.message).toMatch(/incomplete/);
    expect(result.externalSyllabusDiscovery.unavailable).toEqual([
      { lookup: "lti-links", reason: "request-failed" },
      { lookup: "content-toc", reason: "permission-denied", status: 403 },
    ]);
  });

  it("reports partial discovery: sources from the lookup that worked, notice for the one that failed", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: networkError(),
      ltiLinks: [{ LtiLinkId: 7, Title: "Simple Syllabus", Url: "https://s.example/lti", IsVisible: true }],
    });

    const result = await call();

    expect(result.externalSyllabusSources).toHaveLength(1);
    expect(result.externalSyllabusNote).toMatch(/LTI/);
    expect(result.externalSyllabusDiscovery).toMatchObject({
      complete: false,
      unavailable: [{ lookup: "content-toc", reason: "request-failed" }],
    });
  });

  it("reports partial discovery with nothing found when one lookup succeeds empty and the other is forbidden", async () => {
    const call = setup({
      overview: EMPTY_OVERVIEW,
      toc: { Modules: [] },
      ltiLinks: new ApiError(403, "/lti/link/101/", "Forbidden"),
    });

    const result = await call();

    expect(result.externalSyllabusSources).toBeUndefined();
    expect(result.externalSyllabusDiscovery.unavailable).toEqual([
      { lookup: "lti-links", reason: "permission-denied", status: 403 },
    ]);
  });
});
