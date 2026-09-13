import { describe, it, expect, vi, beforeEach } from "vitest";
import { toolResponse, sanitizeError } from "../../src/tools/tool-helpers.js";
import { ApiError } from "../../src/api/index.js";
import { initUpdateChecker, clearUpdateNotice } from "../../src/utils/update-checker.js";

/**
 * The update notice used to surface from one branch of one tool, once per
 * process. In practice that meant nobody ever saw it. Every tool returns
 * through toolResponse, so that is where it belongs.
 *
 * The payload must stay untouched: content[0].text has to remain a pure JSON
 * document, because that is what callers parse.
 */

const okJson = (version: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ version }),
});

async function seedNotice() {
  await initUpdateChecker({
    fetchImpl: vi.fn(async () => okJson("99.0.0")) as unknown as typeof fetch,
    env: {},
    installedVersion: "1.0.0",
    runningFromNpxCache: false,
  });
}

describe("toolResponse", () => {
  beforeEach(() => {
    clearUpdateNotice();
  });

  it("returns only the payload when there is no notice", () => {
    const result = toolResponse({ courses: [1, 2] });
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0].text as string)).toEqual({ courses: [1, 2] });
  });

  it("appends the notice without touching the payload block", async () => {
    await seedNotice();
    const result = toolResponse({ courses: [1, 2] });

    expect(result.content).toHaveLength(2);
    // The thing callers parse is unchanged and still pure JSON.
    expect(JSON.parse(result.content[0].text as string)).toEqual({ courses: [1, 2] });
    expect(result.content[1].text).toContain("99.0.0");
  });

  it("throttles, so a busy session is not spammed", async () => {
    await seedNotice();

    expect(toolResponse({}).content).toHaveLength(2);
    expect(toolResponse({}).content).toHaveLength(1);
    expect(toolResponse({}).content).toHaveLength(1);
  });
});

describe("sanitizeError", () => {
  beforeEach(() => {
    clearUpdateNotice();
  });

  it("attaches the notice to a 401, where a stale install is a likely cause", async () => {
    await seedNotice();
    const result = sanitizeError(new ApiError(401, "/courses", "Session expired."));

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain("Authentication expired");
    expect(result.content[1].text).toContain("99.0.0");
  });

  it("pins the auth command it tells the user to run", () => {
    const result = sanitizeError(new ApiError(401, "/courses", "Session expired."));
    expect(result.content[0].text).toContain("brightspace-mcp-server@latest");
  });

  it("leaves unrelated errors alone", async () => {
    await seedNotice();
    const result = sanitizeError(new ApiError(404, "/courses", "Nope"));
    expect(result.content).toHaveLength(1);
  });
});
