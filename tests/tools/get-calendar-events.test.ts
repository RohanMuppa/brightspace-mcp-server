import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerGetCalendarEvents } from "../../src/tools/get-calendar-events.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Issue #49: the course calendar holds exams, labs, and hand-typed deadlines
 * that no other tool can see.
 */

const BASE = "https://brightspace.example.edu";
const NOW = new Date("2026-09-02T12:00:00.000Z");

const daysFromNow = (days: number): string =>
  new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

const COURSE_A = { Id: 101, Name: "CS 180", Code: "cs180" };
const COURSE_B = { Id: 202, Name: "MA 261", Code: "ma261" };

function makeConfig(): AppConfig {
  return {
    baseUrl: BASE,
    sessionDir: "/tmp/nope",
    tokenTtl: 3600,
    headless: true,
    courseFilter: { activeOnly: true },
  } as AppConfig;
}

type Responder = (path: string) => unknown;

function setup(respond: Responder) {
  const requested: string[] = [];
  const apiClient = {
    lp: (p: string) => `/d2l/api/lp/1.0${p}`,
    le: (orgUnitId: number, p: string) => `/d2l/api/le/1.0/${orgUnitId}${p}`,
    get: vi.fn(async (path: string) => {
      requested.push(path);
      return respond(path);
    }),
  };

  let handler: (args: unknown) => Promise<any>;
  const server = {
    registerTool: (_name: string, _meta: unknown, fn: (args: unknown) => Promise<any>) => {
      handler = fn;
    },
  };

  registerGetCalendarEvents(server as any, apiClient as any, makeConfig());
  return { call: (args: unknown) => handler!(args), requested };
}

const enrollments = (...courses: Array<typeof COURSE_A>) => ({
  Items: courses.map((c) => ({
    OrgUnit: c,
    Access: { ClasslistRoleName: "Student", IsActive: true, LastAccessed: null },
  })),
});

const page = (...events: unknown[]) => ({ Objects: events, Next: null });

const parse = (result: any): any => JSON.parse(result.content[0].text);

function event(id: number, title: string, start: string, extra: Record<string, unknown> = {}) {
  return {
    CalendarEventId: id,
    Title: title,
    Description: "",
    StartDateTime: start,
    EndDateTime: start,
    LocationName: "",
    IsAssociatedWithEntity: false,
    AssociatedEntity: null,
    ...extra,
  };
}

const generated = (id: number, title: string, start: string) =>
  event(id, title, start, {
    IsAssociatedWithEntity: true,
    AssociatedEntity: { AssociatedEntityType: "D2L.LE.Quizzing.Quiz", AssociatedEntityId: 77 },
  });

describe("get_calendar_events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the next seven days by default", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/calendar/")) {
        return page(
          event(1, "Lab 2", daysFromNow(6)),
          event(2, "Lab 3", daysFromNow(8)),
          event(3, "Lab 1", daysFromNow(-1))
        );
      }
      return [];
    });

    const events = parse(await call({}));
    expect(events.map((e: any) => e.title)).toEqual(["Lab 2"]);
  });

  it("returns one event with its course, times, location, description, and link", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/calendar/")) {
        return page(
          event(900, "Midterm", "2026-09-04T23:30:00.000Z", {
            EndDateTime: "2026-09-05T01:30:00.000Z",
            LocationName: "WTHR 200",
            Description: "<p>Bring a <strong>calculator</strong></p>",
          })
        );
      }
      return [];
    });

    expect(parse(await call({}))).toEqual([
      {
        id: 900,
        title: "Midterm",
        courseId: 101,
        courseName: "CS 180",
        start: "2026-09-04T23:30:00.000Z",
        end: "2026-09-05T01:30:00.000Z",
        location: "WTHR 200",
        description: "Bring a **calculator**",
        url: `${BASE}/d2l/le/calendar/101`,
      },
    ]);
  });

  it("omits empty location, end, and description", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/calendar/")) {
        return page(event(5, "Review session", daysFromNow(1), { EndDateTime: null }));
      }
      return [];
    });

    const [only] = parse(await call({}));
    expect(Object.keys(only).sort()).toEqual(
      ["courseId", "courseName", "id", "start", "title", "url"]
    );
  });

  it("hides generated due-date events by default", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/calendar/")) {
        return page(event(1, "Midterm", daysFromNow(2)), generated(2, "Quiz 3 - Due", daysFromNow(3)));
      }
      return [];
    });

    const events = parse(await call({}));
    expect(events.map((e: any) => e.title)).toEqual(["Midterm"]);
  });

  it("shows generated events with generatedFrom when includeGenerated is true", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/calendar/")) {
        return page(generated(2, "Quiz 3 - Due", daysFromNow(3)));
      }
      return [];
    });

    const [only] = parse(await call({ includeGenerated: true }));
    expect(only.generatedFrom).toEqual({ type: "quiz", id: 77 });
  });

  it("rejects a malformed from with a message naming the format", async () => {
    const { call } = setup(() => []);

    const result = await call({ from: "next tuesday" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ISO 8601/);
  });

  it("rejects a malformed to with a message naming the format", async () => {
    const { call } = setup(() => []);

    const result = await call({ to: "2026-13-45" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ISO 8601/);
  });

  it("rejects a to earlier than from without querying Brightspace", async () => {
    const { call, requested } = setup(() => []);

    const result = await call({ from: daysFromNow(10), to: daysFromNow(1) });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/before from/);
    expect(requested).toEqual([]);
  });

  it("explains that from defaults to now when only a past to is given", async () => {
    const { call, requested } = setup(() => []);

    const result = await call({ to: daysFromNow(-3) });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/from defaults to now/);
    expect(requested).toEqual([]);
  });

  it("accepts a zero-length window", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/calendar/")) return page(event(1, "Final", daysFromNow(2)));
      return [];
    });

    const result = await call({ from: daysFromNow(2), to: daysFromNow(2) });
    expect(result.isError).toBeUndefined();
    expect(parse(result).map((e: any) => e.title)).toEqual(["Final"]);
  });

  it("uses an explicit from and to window", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A);
      if (path.includes("/calendar/")) {
        return page(event(1, "Final", daysFromNow(30)), event(2, "Lab", daysFromNow(1)));
      }
      return [];
    });

    const events = parse(await call({ from: daysFromNow(29), to: daysFromNow(31) }));
    expect(events.map((e: any) => e.title)).toEqual(["Final"]);
  });

  it("merges every course's events sorted by start", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A, COURSE_B);
      if (path.includes(`/${COURSE_A.Id}/calendar/`)) {
        return page(event(1, "A day 5", daysFromNow(5)), event(2, "A day 1", daysFromNow(1)));
      }
      if (path.includes(`/${COURSE_B.Id}/calendar/`)) {
        return page(event(3, "B day 3", daysFromNow(3)));
      }
      return [];
    });

    const events = parse(await call({}));
    expect(events.map((e: any) => e.title)).toEqual(["A day 1", "B day 3", "A day 5"]);
  });

  it("keeps the other courses when one course's calendar fails", async () => {
    const { call } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A, COURSE_B);
      if (path.includes(`/${COURSE_A.Id}/calendar/`)) throw new Error("Forbidden");
      if (path.includes(`/${COURSE_B.Id}/calendar/`)) return page(event(3, "Lab", daysFromNow(3)));
      return [];
    });

    const events = parse(await call({}));
    expect(events.map((e: any) => e.courseName)).toEqual(["MA 261"]);
  });

  it("queries only the requested course when courseId is given", async () => {
    const { call, requested } = setup((path) => {
      if (path.includes("/enrollments/")) return enrollments(COURSE_A, COURSE_B);
      if (path.includes("/calendar/")) return page(event(3, "Lab", daysFromNow(3)));
      return [];
    });

    const events = parse(await call({ courseId: COURSE_B.Id }));
    expect(events.map((e: any) => e.courseName)).toEqual(["MA 261"]);
    expect(requested.some((p) => p.includes(`/${COURSE_A.Id}/`))).toBe(false);
  });
});
