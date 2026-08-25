import type { RateLimiterClock } from '../../src/api/security/RateLimiter.js';

/**
 * ManualClock — a test-only RateLimiterClock whose time only moves when explicitly
 * advanced. Used two ways in this test suite:
 *  - Phase 12/13A test files (which exercise register/login many times across many
 *    unrelated test cases, all from the same loopback IP) advance it well past the
 *    15-minute window in beforeEach, so their pre-existing tests are never incidentally
 *    throttled by a feature they were never designed to test.
 *  - The dedicated 13B rate-limit test file uses it to deterministically prove window
 *    behavior without waiting real minutes.
 */
export class ManualClock implements RateLimiterClock {
  private currentMs: number;

  constructor(startMs = Date.now()) {
    this.currentMs = startMs;
  }

  now(): number {
    return this.currentMs;
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}
