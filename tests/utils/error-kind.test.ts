import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorKind } from "../../src/utils/error-kind.js";
import { ApiError, NetworkError, RateLimitError, TokenRefreshError } from "../../src/api/errors.js";
import { AuthProcessError } from "../../src/auth/auth-runner.js";
import { DownloadError } from "../../src/utils/download-errors.js";

describe("errorKind", () => {
  const zodError = z.object({ id: z.number() }).safeParse({ id: "private-id" }).error;
  it.each([
    ["invalid input", zodError, "invalidInput"],
    ["a missing resource", new ApiError(404, "/private-path", "private"), "notFound"],
    ["a permission denial", new ApiError(403, "/private-path", "private"), "permission"],
    ["an expired session", new ApiError(401, "/private-path", "private"), "auth"],
    ["a failed sign-in", new AuthProcessError("timeout", "private"), "auth"],
    ["provider rate limiting", new RateLimitError("/private-path", 5), "rateLimited"],
    ["another HTTP failure", new ApiError(500, "/private-path", "private"), "http"],
    ["a network failure", new NetworkError("private"), "transport"],
    ["a token renewal outage", new TokenRefreshError("private"), "transport"],
    ["an unsupported download format", new DownloadError("unsupportedType", "private"), "unsupportedFormat"],
    ["an unidentifiable download format", new DownloadError("undetectableType", "private"), "unsupportedFormat"],
    ["a refused download name", new DownloadError("pathTraversal", "private"), "rejectedFile"],
    ["an oversized download", new DownloadError("tooLarge", "private"), "rejectedFile"],
    ["a plain error", new Error("private"), "unknown"],
    ["a thrown string", "private", "unknown"],
  ])("classifies %s", (_, error, kind) => {
    expect(errorKind(error)).toBe(kind);
  });
});
