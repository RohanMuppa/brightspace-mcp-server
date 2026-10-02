/**
 * Unit tests for applyCourseFilter, with particular focus on the currentOnly
 * date-window filter. activeOnly/includeCourseIds/excludeCourseIds are also
 * covered here for interaction with currentOnly; canAccess has its own
 * dedicated coverage in course-filter-access.test.ts.
 *
 * Adapted from LunaParker/brightspace-mcp-server (MIT), tests/utils/course-filter.test.ts,
 * with the "both dates null" case corrected to match the documented behavior
 * (undated org units are excluded from currentOnly, not treated as open-ended).
 */

import { describe, it, expect } from "vitest";
import { applyCourseFilter } from "../../src/utils/course-filter.js";
import type { CourseFilterConfig } from "../../src/types/index.js";

interface TestCourse {
  id: number;
  name: string;
  isActive: boolean;
  startDate?: string | null;
  endDate?: string | null;
}

const NOW = Date.parse("2026-04-10T12:00:00.000Z");

function cfg(overrides: Partial<CourseFilterConfig> = {}): CourseFilterConfig {
  return {
    activeOnly: false,
    currentOnly: false,
    ...overrides,
  };
}

const sampleCourses: TestCourse[] = [
  {
    id: 1,
    name: "Past term (Fall 2022)",
    isActive: true,
    startDate: "2022-09-03T04:00:00.000Z",
    endDate: "2022-12-18T04:59:59.000Z",
  },
  {
    id: 2,
    name: "Current term (Winter 2026)",
    isActive: true,
    startDate: "2026-01-12T05:00:00.000Z",
    endDate: "2026-05-01T04:59:59.000Z",
  },
  {
    id: 3,
    name: "Future term (Fall 2026)",
    isActive: true,
    startDate: "2026-09-01T04:00:00.000Z",
    endDate: "2026-12-18T04:59:59.000Z",
  },
  {
    id: 4,
    name: "Undated org unit (Academic Integrity)",
    isActive: true,
    startDate: null,
    endDate: null,
  },
  {
    id: 5,
    name: "Inactive past course",
    isActive: false,
    startDate: "2021-01-01T00:00:00.000Z",
    endDate: "2021-04-30T00:00:00.000Z",
  },
  {
    id: 6,
    name: "Active course, open-ended start",
    isActive: true,
    startDate: null,
    endDate: "2027-12-31T00:00:00.000Z",
  },
  {
    id: 7,
    name: "Active course, open-ended end",
    isActive: true,
    startDate: "2026-01-01T00:00:00.000Z",
    endDate: null,
  },
];

describe("applyCourseFilter", () => {
  describe("with all filters disabled", () => {
    it("returns every course untouched", () => {
      const out = applyCourseFilter(sampleCourses, cfg(), NOW);
      expect(out.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
  });

  describe("activeOnly", () => {
    it("drops inactive enrollments", () => {
      const out = applyCourseFilter(sampleCourses, cfg({ activeOnly: true }), NOW);
      // Only course 5 is inactive
      expect(out.map((c) => c.id).sort()).toEqual([1, 2, 3, 4, 6, 7]);
    });
  });

  describe("currentOnly", () => {
    it("drops past and future term courses, and undated org units", () => {
      const out = applyCourseFilter(sampleCourses, cfg({ currentOnly: true }), NOW);
      // Expected to keep:
      //   2 (Winter 2026, in window)
      //   6 (no start, end in 2027)
      //   7 (start in 2026-01, no end)
      // NOT 1 (2022 ended), NOT 3 (2026-09 not started),
      // NOT 4 (both dates null -- undated org unit, not a real course),
      // NOT 5 (2021 ended -- window doesn't care that it's inactive too)
      expect(out.map((c) => c.id).sort()).toEqual([2, 6, 7]);
    });

    it("excludes a course with both start and end dates null", () => {
      const courses: TestCourse[] = [
        { id: 4, name: "Academic Integrity", isActive: true, startDate: null, endDate: null },
      ];
      const out = applyCourseFilter(courses, cfg({ currentOnly: true }), NOW);
      expect(out).toHaveLength(0);
    });

    it("keeps a course whose endDate is exactly now", () => {
      const courses: TestCourse[] = [
        {
          id: 100,
          name: "ends exactly now",
          isActive: true,
          startDate: "2025-01-01T00:00:00.000Z",
          endDate: new Date(NOW).toISOString(),
        },
      ];
      const out = applyCourseFilter(courses, cfg({ currentOnly: true }), NOW);
      expect(out).toHaveLength(1);
    });

    it("drops a course whose endDate is 1 ms before now", () => {
      const courses: TestCourse[] = [
        {
          id: 101,
          name: "just ended",
          isActive: true,
          startDate: "2025-01-01T00:00:00.000Z",
          endDate: new Date(NOW - 1).toISOString(),
        },
      ];
      const out = applyCourseFilter(courses, cfg({ currentOnly: true }), NOW);
      expect(out).toHaveLength(0);
    });

    it("ignores malformed dates gracefully (treats as open-ended)", () => {
      const courses: TestCourse[] = [
        { id: 200, name: "garbage dates", isActive: true, startDate: "not-a-date", endDate: "also-garbage" },
      ];
      const out = applyCourseFilter(courses, cfg({ currentOnly: true }), NOW);
      expect(out).toHaveLength(1);
    });

    it("defaults to false — does not change behavior when omitted", () => {
      const out = applyCourseFilter(sampleCourses, cfg(), NOW);
      expect(out.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it("stacks with activeOnly: drops inactive, out-of-window, and undated courses", () => {
      const out = applyCourseFilter(
        sampleCourses,
        cfg({ activeOnly: true, currentOnly: true }),
        NOW
      );
      // Start from activeOnly: [1,2,3,4,6,7], then currentOnly drops 1, 3, 4
      expect(out.map((c) => c.id).sort()).toEqual([2, 6, 7]);
    });
  });

  describe("includeCourseIds", () => {
    it("keeps only whitelisted course IDs", () => {
      const out = applyCourseFilter(sampleCourses, cfg({ includeCourseIds: [2, 4] }), NOW);
      expect(out.map((c) => c.id).sort()).toEqual([2, 4]);
    });

    it("applies after activeOnly and currentOnly (an excluded ID stays excluded)", () => {
      const out = applyCourseFilter(
        sampleCourses,
        cfg({ activeOnly: true, currentOnly: true, includeCourseIds: [2, 4] }),
        NOW
      );
      // 4 was already dropped by currentOnly, so only 2 survives.
      expect(out.map((c) => c.id)).toEqual([2]);
    });
  });

  describe("excludeCourseIds", () => {
    it("drops blacklisted course IDs", () => {
      const out = applyCourseFilter(sampleCourses, cfg({ excludeCourseIds: [4, 6] }), NOW);
      expect(out.map((c) => c.id).sort()).toEqual([1, 2, 3, 5, 7]);
    });
  });
});
