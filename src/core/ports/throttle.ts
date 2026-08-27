/**
 * Politeness towards a public court server, shared by every worker.
 *
 * The state lives in one Postgres row per site, not in each process. That is the whole point:
 * `--scale worker=4` must not quadruple the pressure on a tribunal. The unit of rate limiting
 * is the **site**, because that is the unit the site itself limits by.
 *
 * The control law is AIMD, the same idea TCP uses: creep upwards after sustained success, halve
 * immediately on a 429. Backing off fast and recovering slowly is the right asymmetry when the
 * cost of being wrong is a ban.
 */
import type { FailureClass } from '../domain/types.js';

export interface ThrottleLease {
  /** Must be called exactly once, in a `finally`. Frees the concurrency slot. */
  release(): Promise<void>;
}

export interface ThrottleSnapshot {
  concurrency: number;
  inFlight: number;
  tokens: number;
  refillPerSec: number;
  breakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  breakerUntil: string | null;
  retryAfterUntil: string | null;
}

export interface Throttle {
  /** Waits until a token and a concurrency slot are available, or the signal aborts. */
  acquire(site: string, signal?: AbortSignal): Promise<ThrottleLease>;
  /** Feeds the control law. `'OK'` is a success; anything else is a failure class. */
  reportOutcome(
    site: string,
    outcome: FailureClass | 'OK',
    hints?: { retryAfterMs?: number | null },
  ): Promise<void>;
  snapshot(site: string): Promise<ThrottleSnapshot>;
  /** Initialises the row from configuration. Idempotent. */
  ensure(site: string, config: ThrottleConfig): Promise<void>;
}

export interface ThrottleConfig {
  concurrency: number;
  concurrencyMin: number;
  concurrencyMax: number;
  ratePerSec: number;
  burst: number;
}
