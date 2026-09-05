import { describe, it, expect } from "vitest";
import { applyCourseFilter } from "../../src/utils/course-filter.js";
import type { CourseFilterConfig } from "../../src/types/index.js";

/**
 * D2L answers every content endpoint on a closed course with 403, and it tells
 * you in advance which ones those are. Access.IsActive is about the enrollment,
 * so it stays true for a course that ended two years ago. Access.CanAccess is
 * about the course, and it goes false the moment the term closes.
 *
 * Measured on a live Purdue account: 44 active enrollments, 31 of them closed
 * past semesters. Filtering on IsActive alone kept all 44 and spent roughly 70
 * percent of every all-courses fan-out on requests that could only ever 403.
 */

const config = (overrides: Partial<CourseFilterConfig> = {}): CourseFilterConfig => ({
  activeOnly: true,
  ...overrides,
});

const course = (id: number, isActive: boolean, canAccess?: boolean) => ({
  id,
  isActive,
  ...(canAccess === undefined ? {} : { canAccess }),
});

describe("closed courses", () => {
  it("drops a course the tenant says cannot be accessed", () => {
    const courses = [
      course(1, true, true), // Fall 2026, open
      course(2, true, false), // Fall 2024, closed but still enrolled
    ];

    expect(applyCourseFilter(courses, config()).map((c) => c.id)).toEqual([1]);
  });

  it("keeps a course when canAccess is absent, since unknown is not denied", () => {
    // Older tenants and other schools may not send the field. Dropping a
    // course we know nothing about would silently hide real work.
    const courses = [course(1, true), course(2, true)];

    expect(applyCourseFilter(courses, config())).toHaveLength(2);
  });

  it("still respects activeOnly false, which asks for everything", () => {
    const courses = [course(1, true, true), course(2, false, false)];

    expect(applyCourseFilter(courses, config({ activeOnly: false }))).toHaveLength(2);
  });

  it("does not resurrect a closed course through the include list", () => {
    // Consistent with how activeOnly has always treated includeCourseIds: the
    // active check runs first. A student who really wants a past course passes
    // courseId to the tool itself, which bypasses this filter entirely.
    const courses = [course(1, true, true), course(2, true, false)];

    const result = applyCourseFilter(courses, config({ includeCourseIds: [2] }));
    expect(result).toEqual([]);
  });

  it("returns a closed course when the caller asks for everything by id", () => {
    // activeOnly false is the config-level way to reach past semesters.
    const courses = [course(1, true, true), course(2, true, false)];

    const result = applyCourseFilter(
      courses,
      config({ activeOnly: false, includeCourseIds: [2] })
    );
    expect(result.map((c) => c.id)).toEqual([2]);
  });

  it("still drops an inactive enrollment", () => {
    const courses = [course(1, true, true), course(2, false, true)];

    expect(applyCourseFilter(courses, config()).map((c) => c.id)).toEqual([1]);
  });

  it("reproduces the measured Purdue split", () => {
    const courses = [
      ...Array.from({ length: 13 }, (_, i) => course(100 + i, true, true)),
      ...Array.from({ length: 31 }, (_, i) => course(200 + i, true, false)),
    ];

    expect(courses).toHaveLength(44);
    expect(applyCourseFilter(courses, config())).toHaveLength(13);
  });
});
