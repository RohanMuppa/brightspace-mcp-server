import { describe, it, expect, vi } from "vitest";
import { withRetry, isRetryableFailure, retryAfterMsFrom } from "../../src/api/retry.js";
import { ApiError, RateLimitError, NetworkError } from "../../src/api/errors.js";

/**
 * Transient failures (429, 5xx, a dropped connection) are retried with
 * exponential backoff and jitter. Anything that will not get better by
 * waiting (401, 403, 404) is thrown straight through.
 */

const noJitter = () => 0;

function failing(sequence: Array<unknown | "ok">) {
  let call = 0;
  return vi.fn(async () => {
    const outcome = sequence[call++];
    if (outcome === "ok") return "payload";
    throw outcome;
  });
}

describe("withRetry", () => {
  it("returns on the first success without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const fn = failing(["ok"]);
    const result = await withRetry(fn, { sleep, jitter: noJitter, shouldRetry: () => true });
    expect(result).toBe("payload");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("backs off 250, 500, 1000 with jitter stubbed to zero", async () => {
    const sleep = vi.fn(async () => {});
    const err = new NetworkError("flaky");
    const fn = failing([err, err, err, "ok"]);
    await withRetry(fn, { maxAttempts: 4, sleep, jitter: noJitter, shouldRetry: () => true });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([250, 500, 1000]);
  });

  it("caps the backoff at maxMs", async () => {
    const sleep = vi.fn(async () => {});
    const err = new NetworkError("flaky");
    const fn = failing([err, err, err, "ok"]);
    await withRetry(fn, { maxAttempts: 4, maxMs: 600, sleep, jitter: noJitter, shouldRetry: () => true });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([250, 500, 600]);
  });

  it("adds up to 30 percent jitter on top of the base delay", async () => {
    const sleep = vi.fn(async () => {});
    const err = new NetworkError("flaky");
    const fn = failing([err, "ok"]);
    await withRetry(fn, { sleep, jitter: () => 1, shouldRetry: () => true });
    expect(sleep).toHaveBeenCalledWith(325);
  });

  it("honors Retry-After verbatim, even past maxMs, and without jitter", async () => {
    const sleep = vi.fn(async () => {});
    const err = new RateLimitError("/x", 30);
    const fn = failing([err, "ok"]);
    await withRetry(fn, {
      maxMs: 5000,
      sleep,
      jitter: () => 1,
      shouldRetry: isRetryableFailure,
      retryAfterMs: retryAfterMsFrom,
    });
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("recovers from a 503 on the second attempt", async () => {
    const sleep = vi.fn(async () => {});
    const fn = failing([new ApiError(503, "/x", "unavailable"), "ok"]);
    const result = await withRetry(fn, { sleep, jitter: noJitter, shouldRetry: isRetryableFailure });
    expect(result).toBe("payload");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws the last error after maxAttempts failures", async () => {
    const sleep = vi.fn(async () => {});
    const last = new ApiError(502, "/x", "third");
    const fn = failing([new ApiError(500, "/x", "first"), new ApiError(504, "/x", "second"), last]);
    await expect(
      withRetry(fn, { sleep, jitter: noJitter, shouldRetry: isRetryableFailure })
    ).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry what waiting cannot fix", async () => {
    for (const status of [401, 403, 404, 400]) {
      const sleep = vi.fn(async () => {});
      const err = new ApiError(status, "/x", "no");
      const fn = failing([err, "ok"]);
      await expect(
        withRetry(fn, { sleep, jitter: noJitter, shouldRetry: isRetryableFailure })
      ).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("retries a network error", async () => {
    const sleep = vi.fn(async () => {});
    const fn = failing([new NetworkError("ECONNRESET"), "ok"]);
    await expect(
      withRetry(fn, { sleep, jitter: noJitter, shouldRetry: isRetryableFailure })
    ).resolves.toBe("payload");
  });
});

describe("isRetryableFailure", () => {
  it("classifies exactly 429, 5xx, and network errors as retryable", () => {
    expect(isRetryableFailure(new RateLimitError("/x"))).toBe(true);
    expect(isRetryableFailure(new ApiError(500, "/x", ""))).toBe(true);
    expect(isRetryableFailure(new ApiError(599, "/x", ""))).toBe(true);
    expect(isRetryableFailure(new NetworkError("x"))).toBe(true);
    expect(isRetryableFailure(new ApiError(401, "/x", ""))).toBe(false);
    expect(isRetryableFailure(new ApiError(403, "/x", ""))).toBe(false);
    expect(isRetryableFailure(new ApiError(404, "/x", ""))).toBe(false);
    expect(isRetryableFailure(new Error("plain"))).toBe(false);
  });
});

describe("retryAfterMsFrom", () => {
  it("reads seconds off a RateLimitError and nothing else", () => {
    expect(retryAfterMsFrom(new RateLimitError("/x", 7))).toBe(7000);
    expect(retryAfterMsFrom(new RateLimitError("/x"))).toBeUndefined();
    expect(retryAfterMsFrom(new ApiError(503, "/x", ""))).toBeUndefined();
  });
});
