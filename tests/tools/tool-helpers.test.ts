/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProcessError, type AuthFailureKind } from "../../src/auth/auth-runner.js";
import { ApiError, NetworkError, RateLimitError, TokenRefreshError } from "../../src/api/errors.js";

vi.mock("../../src/utils/logger.js", () => ({ log: vi.fn() }));
vi.mock("../../src/utils/update-checker.js", () => ({ getUpdateNotice: vi.fn(() => null) }));

const { getUpdateNotice } = await import("../../src/utils/update-checker.js");
const { sanitizeError, toolResponse, errorResponse } = await import("../../src/tools/tool-helpers.js");

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map(part => part.text ?? "").join("\n");

describe("toolResponse", () => {
  beforeEach(() => {
    vi.mocked(getUpdateNotice).mockReturnValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the payload as pretty JSON", () => {
    expect(toolResponse({ courses: [1, 2] }).content).toEqual([
      { type: "text", text: '{\n  "courses": [\n    1,\n    2\n  ]\n}' },
    ]);
  });

  // check_auth used to carry this. With authentication folded into the tools
  // there is no call the user reliably makes, so an available update has to
  // ride an ordinary result or it would never be seen.
  it("appends an available-update notice as a second block", () => {
    vi.mocked(getUpdateNotice).mockReturnValue("Update available: v2.0.0 to v2.1.0.");

    const result = toolResponse({ ok: true });

    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({
      type: "text",
      text: "Update available: v2.0.0 to v2.1.0.",
    });
  });

  it("leaves the result alone when there is no notice", () => {
    expect(toolResponse({ ok: true }).content).toHaveLength(1);
  });
});

describe("sanitizeError", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Authentication now fails inside an ordinary tool call, so every kind has
  // to arrive as advice the user can act on rather than as "an unexpected
  // error occurred", which is where all of these used to land.
  const expectedGuidance: Array<[AuthFailureKind, string]> = [
    ["busy", "already running in another process"],
    ["cooldown", "MFA prompt went unanswered"],
    ["unsupported", "cannot be completed without a person at the keyboard"],
    ["secureStorage", "credential store is locked"],
    ["transport", "could not be reached to sign in"],
    ["timeout", "did not finish in time"],
    ["failed", "did not complete"],
  ];

  it.each(expectedGuidance)("explains a %s sign-in failure", (kind, expected) => {
    const result = sanitizeError(new AuthProcessError(kind, "internal detail"));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(expected);
  });

  it("never repeats the raw failure text back to the caller", () => {
    const result = sanitizeError(
      new AuthProcessError("failed", "chromium crashed at /home/elliot/.cache/ms-playwright")
    );

    expect(textOf(result)).not.toContain("ms-playwright");
    expect(textOf(result)).not.toContain("/home/elliot");
  });

  // TokenRefreshError extends NetworkError, and the generic network message
  // would tell the user to check a connection that is fine while hiding the
  // part that matters: the saved login survived.
  it("distinguishes a token-service outage from a dead connection", () => {
    const result = sanitizeError(new TokenRefreshError("token service request failed"));

    expect(textOf(result)).toContain("saved login was kept");
    expect(textOf(result)).not.toContain("Check your internet connection");
  });

  it("still maps the HTTP and input failures it always did", () => {
    expect(textOf(sanitizeError(new ApiError(404, "/x", "nope")))).toContain("Resource not found");
    expect(textOf(sanitizeError(new ApiError(403, "/x", "nope")))).toContain("Access denied");
    expect(textOf(sanitizeError(new RateLimitError("/x", 30)))).toContain("Rate limited");
    expect(textOf(sanitizeError(new NetworkError("socket hang up")))).toContain(
      "Check your internet connection"
    );
    expect(textOf(sanitizeError(new Error("something else")))).toContain("unexpected error");
  });

  it("does not attach an update notice to an error", () => {
    vi.mocked(getUpdateNotice).mockReturnValue("Update available: v2.0.0 to v2.1.0.");

    expect(errorResponse("nope").content).toHaveLength(1);
    expect(getUpdateNotice).not.toHaveBeenCalled();
  });
});
