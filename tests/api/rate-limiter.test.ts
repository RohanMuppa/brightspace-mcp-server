import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TokenBucket } from "../../src/api/rate-limiter.js";

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should consume tokens when bucket has capacity", async () => {
    const bucket = new TokenBucket(10, 3);

    // Should consume immediately without waiting
    await bucket.consume(1);
    expect(bucket.availableTokens).toBe(9);

    await bucket.consume(3);
    expect(bucket.availableTokens).toBe(6);
  });

  it("should allow bursts up to capacity", async () => {
    const bucket = new TokenBucket(10, 3);

    // Consume entire burst capacity
    await bucket.consume(10);
    expect(bucket.availableTokens).toBe(0);
  });

  it("should tryConsume return true when tokens available", () => {
    const bucket = new TokenBucket(10, 3);

    expect(bucket.tryConsume(5)).toBe(true);
    expect(bucket.availableTokens).toBe(5);

    expect(bucket.tryConsume(3)).toBe(true);
    expect(bucket.availableTokens).toBe(2);
  });

  it("should tryConsume return false when bucket empty", () => {
    const bucket = new TokenBucket(10, 3);

    // Drain bucket
    bucket.tryConsume(10);
    expect(bucket.availableTokens).toBe(0);

    // Try to consume more - should fail
    expect(bucket.tryConsume(1)).toBe(false);
    expect(bucket.availableTokens).toBe(0);
  });

  it("should refill tokens over time", () => {
    const bucket = new TokenBucket(10, 3); // 3 tokens per second

    // Drain bucket
    bucket.tryConsume(10);
    expect(bucket.availableTokens).toBe(0);

    // Advance 1 second - should add 3 tokens
    vi.advanceTimersByTime(1000);
    expect(bucket.availableTokens).toBe(3);

    // Advance another 2 seconds - should add 6 more tokens (total 9)
    vi.advanceTimersByTime(2000);
    expect(bucket.availableTokens).toBe(9);

    // Advance another 1 second - should cap at capacity (10)
    vi.advanceTimersByTime(1000);
    expect(bucket.availableTokens).toBe(10);
  });

  it("should not exceed capacity after refill", () => {
    const bucket = new TokenBucket(10, 5);

    // Consume some tokens
    bucket.tryConsume(5);
    expect(bucket.availableTokens).toBe(5);

    // Advance time far into future - should cap at capacity
    vi.advanceTimersByTime(10000);
    expect(bucket.availableTokens).toBe(10);
  });

  it("should wait when bucket is empty", async () => {
    const bucket = new TokenBucket(10, 2); // 2 tokens per second

    // Drain bucket
    await bucket.consume(10);
    expect(bucket.availableTokens).toBe(0);

    // Start consuming (needs to wait for 1 token = 0.5 seconds)
    const consumePromise = bucket.consume(1);

    // Should not resolve immediately
    let resolved = false;
    consumePromise.then(() => {
      resolved = true;
    });

    // Check not resolved yet
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    // Advance time to allow refill (500ms for 1 token at 2/sec)
    await vi.advanceTimersByTimeAsync(500);
    await consumePromise;

    expect(resolved).toBe(true);
  });

  it("should calculate correct wait time for multiple tokens", async () => {
    const bucket = new TokenBucket(10, 4); // 4 tokens per second

    // Drain bucket completely
    await bucket.consume(10);
    expect(bucket.availableTokens).toBe(0);

    // Need 8 tokens, have 0, refill rate is 4/sec
    // Should wait 8/4 = 2 seconds
    const consumePromise = bucket.consume(8);

    let resolved = false;
    consumePromise.then(() => {
      resolved = true;
    });

    // Not resolved after 1 second
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);

    // Should resolve after 2 seconds
    await vi.advanceTimersByTimeAsync(1000);
    await consumePromise;

    expect(resolved).toBe(true);
  });

  it("paces concurrent waiters instead of releasing them all on one refill", async () => {
    const bucket = new TokenBucket(10, 2); // 2 tokens per second

    const released: number[] = [];
    const all = Promise.all(
      Array.from({ length: 14 }, (_, i) =>
        bucket.consume(1).then(() => {
          released.push(i);
        })
      )
    );

    // The burst capacity goes out at once, and nothing more.
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveLength(10);

    // One token accrues every 500ms, so one waiter is released every 500ms.
    await vi.advanceTimersByTimeAsync(500);
    expect(released).toHaveLength(11);

    await vi.advanceTimersByTimeAsync(500);
    expect(released).toHaveLength(12);

    await vi.advanceTimersByTimeAsync(1000);
    expect(released).toHaveLength(14);

    await all;
    // Fourteen tokens taken, four accrued during the two seconds of waiting.
    expect(bucket.availableTokens).toBe(0);
  });

  it("never reports a negative balance while waiters are still queued", async () => {
    const bucket = new TokenBucket(2, 1);

    await bucket.consume(2);
    const pending = bucket.consume(2);

    expect(bucket.availableTokens).toBe(0);

    await vi.advanceTimersByTimeAsync(2000);
    await pending;
  });

  it("should handle partial token availability correctly", async () => {
    const bucket = new TokenBucket(10, 5); // 5 tokens per second

    // Consume most tokens, leaving 2
    await bucket.consume(8);
    expect(bucket.availableTokens).toBe(2);

    // Try to consume 5 tokens (need 3 more, at 5/sec = 0.6s wait)
    const consumePromise = bucket.consume(5);

    let resolved = false;
    consumePromise.then(() => {
      resolved = true;
    });

    // Not resolved yet
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    // Advance 600ms (enough for 3 tokens at 5/sec)
    await vi.advanceTimersByTimeAsync(600);
    await consumePromise;

    expect(resolved).toBe(true);
  });
});
