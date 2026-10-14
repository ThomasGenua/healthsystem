/**
 * Request rate limiting.
 *
 * Two reasons this is not optional here, and the second is the sharper one:
 *
 *   An interface engine on a 5 Mbps satellite tail has very little headroom.
 *   A client retrying in a tight loop can saturate the link that the queue is
 *   trying to drain through, turning one misbehaving consumer into an outage
 *   for a whole community site.
 *
 *   Every refused request to a patient-data path writes a row to the audit
 *   trail. That is the right behaviour — a trail that omits failures cannot
 *   show someone trying doors — but it means an unauthenticated caller can
 *   grow the database by hammering the facade. Without a limit, the control
 *   that records intrusion attempts becomes the way to exhaust the disk.
 *
 * A token bucket rather than a fixed window: it admits a burst, which real
 * clients produce, without admitting a sustained flood, and it does not reset
 * on a clock boundary an attacker can synchronise to.
 *
 * Counting is per principal when the caller is authenticated and per source
 * address when it is not, so one noisy anonymous client cannot exhaust the
 * budget of a credentialed feed, and a credentialed feed is accounted for
 * wherever it connects from.
 *
 * In memory, matching the engine's single-writer design. A Northstar node is one
 * process; sharing this across nodes would need shared state, and the note in
 * the README says so rather than pretending otherwise.
 */

export interface RateLimitPolicy {
  /** Sustained requests per minute for a credentialed caller. */
  authenticatedPerMinute?: number;
  /** Sustained requests per minute for an unauthenticated one. */
  anonymousPerMinute?: number;
  /** Burst allowance, as a multiple of the per-minute rate. */
  burstFactor?: number;
  /** Set false to disable entirely. */
  enabled?: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
  /** True only on the request that crosses the threshold, so a flood records once. */
  firstRefusal: boolean;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
  refusing: boolean;
}

/** Bound on tracked buckets, so rotating source addresses cannot grow memory. */
const MAX_BUCKETS = 10_000;

const DEFAULTS = {
  authenticatedPerMinute: 1_200,
  anonymousPerMinute: 120,
  burstFactor: 2,
};

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private policy: Required<Omit<RateLimitPolicy, "enabled">> & { enabled: boolean };

  constructor(policy: RateLimitPolicy = {}) {
    this.policy = {
      authenticatedPerMinute: policy.authenticatedPerMinute ?? DEFAULTS.authenticatedPerMinute,
      anonymousPerMinute: policy.anonymousPerMinute ?? DEFAULTS.anonymousPerMinute,
      burstFactor: policy.burstFactor ?? DEFAULTS.burstFactor,
      enabled: policy.enabled !== false,
    };
  }

  get enabled(): boolean {
    return this.policy.enabled;
  }

  describe(): RateLimitPolicy & { tracked: number } {
    return { ...this.policy, tracked: this.buckets.size };
  }

  /**
   * Spends one token for a caller.
   *
   * @param key           principal id when authenticated, otherwise source address
   * @param authenticated which rate applies
   */
  check(key: string, authenticated: boolean): RateLimitDecision {
    if (!this.policy.enabled) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSec: 0, firstRefusal: false };
    }

    const perMinute = authenticated ? this.policy.authenticatedPerMinute : this.policy.anonymousPerMinute;
    const capacity = Math.max(1, Math.ceil(perMinute * this.policy.burstFactor));
    const perMs = perMinute / 60_000;
    const now = Date.now();

    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Evicting the least recently refilled entry keeps this bounded without
      // a sweep. An attacker rotating addresses evicts their own entries
      // first, since a legitimate caller refills more often.
      if (this.buckets.size >= MAX_BUCKETS) {
        let oldestKey: string | null = null;
        let oldest = Infinity;
        for (const [k, b] of this.buckets) {
          if (b.lastRefill < oldest) {
            oldest = b.lastRefill;
            oldestKey = k;
          }
        }
        if (oldestKey !== null) this.buckets.delete(oldestKey);
      }
      bucket = { tokens: capacity, lastRefill: now, refusing: false };
      this.buckets.set(key, bucket);
    }

    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.lastRefill) * perMs);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      const firstRefusal = !bucket.refusing;
      bucket.refusing = true;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000)),
        firstRefusal,
      };
    }

    bucket.tokens -= 1;
    bucket.refusing = false;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSec: 0, firstRefusal: false };
  }

  /** Test and operational hook: forget all counters. */
  reset(): void {
    this.buckets.clear();
  }
}
