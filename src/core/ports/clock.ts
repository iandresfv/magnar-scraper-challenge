/**
 * Time and sleeping, as a port.
 *
 * Backoff, leases and the token bucket are all time arithmetic, and time arithmetic that reads
 * `Date.now()` directly can only be tested by actually waiting. Injecting it means the retry
 * sequence tests run in microseconds and assert exact delays.
 */
export interface Clock {
  now(): number;
  /** Resolves after `ms`, or rejects with an `AbortError` if the signal fires first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Uniform random in `[min, max)`. Injected so jitter is deterministic under test. */
export type Random = (min: number, max: number) => number;
