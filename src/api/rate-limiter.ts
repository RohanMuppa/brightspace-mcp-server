/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

// Token bucket rate limiter - allows bursts up to capacity
// Conservative defaults: capacity 10, refill 3/sec

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity; // Start with full bucket
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    const elapsedSeconds = elapsedMs / 1000;

    // Add tokens based on elapsed time
    const tokensToAdd = elapsedSeconds * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Take `count` tokens, waiting for them if the bucket is short.
   *
   * The tokens are deducted before the wait rather than after it, so
   * concurrent callers queue behind one another. Deducting afterwards let
   * every caller read the same empty bucket, wait for the same single token,
   * and then wake together and take it: a fan-out across courses drained the
   * burst and then admitted the whole remainder one refill later, which is the
   * 429 storm this limiter exists to prevent. It also left the balance deeply
   * negative, so the next unrelated request paid the whole debt in one wait.
   *
   * A negative balance is that debt, owed by the waiters already queued, and
   * refill() pays it down at the refill rate.
   */
  async consume(count: number = 1): Promise<void> {
    this.refill();

    const shortfall = count - this.tokens;
    this.tokens -= count;

    if (shortfall <= 0) {
      // Enough tokens were already banked - proceed immediately.
      return;
    }

    const waitTimeMs = (shortfall / this.refillRate) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitTimeMs));
  }

  tryConsume(count: number = 1): boolean {
    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }

    return false;
  }

  /** Tokens free to take right now. Never negative: an outstanding
   * reservation is a debt, not a negative supply. */
  get availableTokens(): number {
    this.refill();
    return Math.max(0, this.tokens);
  }
}
