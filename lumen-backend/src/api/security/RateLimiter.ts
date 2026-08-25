export interface RateLimiterClock {
  now(): number;
}

const realClock: RateLimiterClock = { now: () => Date.now() };

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  /** Only meaningful when allowed === false. */
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  windowStart: number;
  windowMs: number;
}

/**
 * RateLimiter — a small, focused, dependency-free fixed-window counter.
 *
 * Approved design (Workstream 13B): in-memory Map, keyed by caller-supplied string
 * (this project uses `${clientIp}:${category}` — see ApiRouter), fixed-window algorithm,
 * periodic sweep to bound memory, injectable clock for deterministic testing, fail-open
 * on any unexpected internal error (see ApiRouter.handle()'s try/catch around the check
 * call — this class itself has no reason to throw under normal Map operations, but the
 * failure-mode contract lives at the call site, not here).
 *
 * Explicitly NOT: persistent, multi-instance-aware, or account/user-keyed. Those are
 * documented, accepted limitations of the approved scope — see the 13B discovery report.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly clock: RateLimiterClock = realClock,
    private readonly cleanupIntervalMs: number = 5 * 60 * 1000,
  ) {}

  /** Starts the periodic sweep. Safe to call multiple times — a no-op if already running. */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.sweep(), this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /** Removes buckets whose window has already fully expired — bounds memory growth. */
  sweep(): void {
    const now = this.clock.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= bucket.windowMs) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Checks and (if allowed) increments the counter for `key` under `config` in one
   * synchronous call — atomic with respect to other JS execution on Node's single
   * event-loop thread, which is what makes this safe under concurrent requests without
   * any additional locking.
   */
  check(key: string, config: RateLimitConfig): RateLimitCheckResult {
    const now = this.clock.now();
    const existing = this.buckets.get(key);

    if (!existing || now - existing.windowStart >= config.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now, windowMs: config.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (existing.count < config.maxRequests) {
      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const remainingMs = config.windowMs - (now - existing.windowStart);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
  }

  /** Test/introspection only — never used by production request handling. */
  get bucketCount(): number {
    return this.buckets.size;
  }
}
