/**
 * Backoff arithmetic.
 *
 * The variant is **decorrelated jitter**: `sleep = min(cap, uniform(base, previous × 3))`.
 *
 * Why not plain exponential backoff: when several workers are rate-limited by the same server at
 * the same moment — which is exactly what happens, because they share one origin — a
 * deterministic schedule sends them all back at the same instant, and the second wave is as
 * synchronised as the first. Jitter breaks the convoy.
 *
 * Why decorrelated rather than full jitter: full jitter (`uniform(0, cap)`) forgets everything it
 * learned, so a server that is badly overloaded gets probed just as eagerly on the sixth attempt
 * as on the first. Decorrelated grows the *upper* bound from the previous wait, so repeated
 * failures widen the spread while the floor stays polite.
 *
 * `Retry-After` overrides all of it when the server sends one — with a small jitter added, since
 * a header that tells ten workers "come back in three seconds" would otherwise synchronise them
 * perfectly.
 */
import type { Random } from '../ports/clock.js';

export interface BackoffOptions {
  /** The floor, and the first wait. */
  baseMs: number;
  /** The ceiling. No single wait exceeds it, however many attempts have failed. */
  capMs: number;
  /** Growth of the upper bound per attempt. Three is the value the AWS paper settles on. */
  factor?: number;
}

export const defaultRandom: Random = (min, max) => min + Math.random() * (max - min);

/**
 * The next delay, given the previous one.
 *
 * `previousMs` of zero means "first attempt", which yields `baseMs` exactly — a deterministic
 * first wait is worth having, because it makes the common single-retry case predictable.
 */
export function decorrelatedJitter(
  previousMs: number,
  options: BackoffOptions,
  random: Random = defaultRandom,
): number {
  const { baseMs, capMs, factor = 3 } = options;
  if (previousMs <= 0) return Math.min(baseMs, capMs);
  const upper = Math.min(capMs, previousMs * factor);
  if (upper <= baseMs) return Math.min(baseMs, capMs);
  return Math.min(capMs, Math.round(random(baseMs, upper)));
}

/** The whole sequence for `attempts` tries. Used by the tests and by the README's table. */
export function backoffSequence(
  attempts: number,
  options: BackoffOptions,
  random: Random = defaultRandom,
): number[] {
  const delays: number[] = [];
  let previous = 0;
  for (let i = 0; i < attempts; i++) {
    previous = decorrelatedJitter(previous, options, random);
    delays.push(previous);
  }
  return delays;
}

/**
 * Reads `Retry-After`, in both forms the spec allows.
 *
 * Seconds are the common case; an HTTP-date is legal and is the form clients most often get
 * wrong. Returns `null` when the header is absent or unparseable, which is the case backoff has
 * to cover on its own — and the case this site actually presents, since the reconnaissance never
 * observed a `Retry-After` at all.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  // A date in the past means "now"; a negative wait would be nonsense.
  return Math.max(0, asDate - now);
}

/**
 * The wait to honour when the server asked for one.
 *
 * Capped, because a server is allowed to ask for an hour and a crawler is allowed to decide that
 * is longer than it is prepared to hold a lease. Jittered, because a shared instruction is a
 * synchronisation point.
 */
export function honourRetryAfter(
  retryAfterMs: number,
  options: { capMs: number; jitterMs?: number },
  random: Random = defaultRandom,
): number {
  const jitter = options.jitterMs ?? 500;
  return Math.min(options.capMs, retryAfterMs + Math.round(random(0, jitter)));
}
