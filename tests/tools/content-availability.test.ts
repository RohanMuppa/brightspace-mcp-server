import { describe, expect, it } from "vitest";
import { contentAvailability } from "../../src/tools/content-availability.js";

const now = new Date("2030-01-15T12:00:00Z");
const future = "2030-01-16T12:00:00Z";
const past = "2030-01-14T12:00:00Z";

describe("content availability", () => {
  it.each([
    [{}, "available"],
    [{ StartDate: future }, "not_yet_open"],
    [{ EndDate: past }, "ended"],
    [{ StartDate: future, EndDate: past }, "ended"],
    [{ IsHidden: true }, "hidden"],
    [{ IsLocked: true }, "locked"],
    [{ IsLocked: true, StartDate: future }, "locked"],
    [{ IsHidden: true, StartDate: future }, "hidden"],
    [{ StartDate: now.toISOString() }, "available"],
    [{ EndDate: now.toISOString() }, "ended"],
    [{ StartDate: "2030-01-15T13:00:00+01:00" }, "available"],
  ])("explains %j as %s", (metadata, status) => {
    const result = contentAvailability(metadata, now);
    expect(result.availabilityStatus).toBe(status);
    expect(result.isAvailable).toBe(status === "available");
    expect(result.availabilityMessage).toEqual(expect.any(String));
  });

  it("understands both module and table-of-contents date fields", () => {
    expect(contentAvailability({ ModuleStartDate: future }, now)).toMatchObject({ availabilityStatus: "not_yet_open", startDate: future });
    expect(contentAvailability({ StartDateTime: future, EndDateTime: "2030-02-01T00:00:00Z" }, now)).toMatchObject({ startDate: future, endDate: "2030-02-01T00:00:00Z" });
  });

  it("does not promise a release when topic and module windows never overlap", () => {
    const parent = contentAvailability({ ModuleStartDate: "2030-02-01T00:00:00Z" }, now);
    expect(contentAvailability({ EndDate: "2030-01-20T00:00:00Z" }, now, parent)).toMatchObject({ isAvailable: false, availabilityStatus: "locked" });
  });

  it("does not claim a restriction from malformed dates", () => {
    expect(contentAvailability({ StartDate: "invalid", EndDate: "" }, now)).toMatchObject({ isAvailable: true, startDate: null, endDate: null });
  });

  it("rejects a non-ISO-8601 date string instead of parsing it loosely", () => {
    expect(contentAvailability({ StartDate: "December 2030" }, now)).toMatchObject({ isAvailable: true, availabilityStatus: "available", startDate: null });
  });

  it("does not report a locked parent as merely not yet open", () => {
    const parent = contentAvailability({ IsLocked: true }, now);
    expect(contentAvailability({ StartDate: future }, now, parent)).toMatchObject({ isAvailable: false, availabilityStatus: "locked" });
  });

  it("does not report its own IsLocked flag as a future release date", () => {
    expect(contentAvailability({ IsLocked: true, StartDate: future }, now)).toMatchObject({ isAvailable: false, availabilityStatus: "locked" });
  });

  it("intersects topic and module windows", () => {
    const parent = contentAvailability({ ModuleStartDate: future, ModuleEndDate: "2030-02-01T00:00:00Z" }, now);
    expect(contentAvailability({ StartDate: past, EndDate: "2030-03-01T00:00:00Z" }, now, parent)).toMatchObject({
      availabilityStatus: "not_yet_open", startDate: future, endDate: "2030-02-01T00:00:00Z",
    });
    expect(contentAvailability({ StartDate: "2030-01-20T00:00:00Z", EndDate: "2030-01-25T00:00:00Z" }, now, parent)).toMatchObject({
      startDate: "2030-01-20T00:00:00Z", endDate: "2030-01-25T00:00:00Z",
    });
  });

  it.each([
    [{ IsHidden: true }, "hidden"],
    [{ IsLocked: true }, "locked"],
    [{ ModuleStartDate: future }, "not_yet_open"],
    [{ ModuleEndDate: past }, "ended"],
  ])("inherits an enclosing module restriction: %s", (metadata, status) => {
    const parent = contentAvailability(metadata, now);
    expect(contentAvailability({}, now, parent)).toMatchObject({ isAvailable: false, availabilityStatus: status });
  });
});
