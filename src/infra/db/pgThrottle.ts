/**
 * Politeness towards a public court server, shared by every worker process.
 *
 * The state lives in **one row per site**, not in each process, and that is the entire point.
 * `docker compose --scale worker=4` must not quadruple the pressure on a tribunal: the unit of
 * rate limiting is the *site*, because that is the unit the site itself limits by. A per-process
 * limiter would make scaling and courtesy pull in opposite directions.
 *
 * Acquisition is one statement:
 *
 * ```sql
 * UPDATE juris.site_throttle SET
 *   tokens = LEAST(capacity, tokens + refill_per_sec * elapsed) - 1,
 *   in_flight = in_flight + 1
 * WHERE site = $1 AND breaker is closed AND in_flight < concurrency AND tokens >= 1
 * RETURNING …
 * ```
 *
 * The refill is computed from `now() - updated_at` rather than by a timer, so there is no clock
 * to keep and no drift between processes. Zero rows returned means "not now"; the caller waits
 * and asks again. Because the whole decision is one atomic UPDATE, two workers cannot both
 * believe they took the last slot.
 *
 * The control law is **AIMD**, the same asymmetry TCP uses: creep upward after sustained success,
 * halve immediately on a 429. Backing off fast and recovering slowly is the right shape when the
 * cost of being wrong is a ban and the benefit of being right is a few minutes.
 */
import type { FailureClass } from '../../core/domain/types.js';
import type {
  Throttle,
  ThrottleConfig,
  ThrottleLease,
  ThrottleSnapshot,
} from '../../core/ports/throttle.js';
import type { SqlExecutor } from '../../core/ports/sql.js';
import { readNumber, readString, readTimestampOrNull } from './repos/rowMapping.js';

export interface PgThrottleOptions {
  /** How long to wait before asking again when the row says "not now". */
  retryDelayMs?: number;
  /** How long a snapshot may be reused. One second keeps the row from becoming a hot spot. */
  cacheMs?: number;
  /** Successes needed before the concurrency creeps up by one. */
  increaseAfterOk?: number;
  /** Consecutive breaker openings before the run is abandoned. */
  maxConsecutiveOpens?: number;
  /** How long the breaker stays open the first time. Doubles on each consecutive opening. */
  breakerBaseMs?: number;
  breakerCapMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class BreakerAbort extends Error {
  constructor(
    readonly opens: number,
    message: string,
  ) {
    super(message);
    this.name = 'BreakerAbort';
  }
}

export class PgThrottle implements Throttle {
  private readonly retryDelayMs: number;
  private readonly cacheMs: number;
  private readonly increaseAfterOk: number;
  private readonly maxConsecutiveOpens: number;
  private readonly breakerBaseMs: number;
  private readonly breakerCapMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  /** Last snapshot and when it was taken, so the row is not queried on every decision. */
  private cache = new Map<string, { at: number; snapshot: ThrottleSnapshot }>();

  constructor(
    private readonly db: SqlExecutor,
    options: PgThrottleOptions = {},
  ) {
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.cacheMs = options.cacheMs ?? 1_000;
    this.increaseAfterOk = options.increaseAfterOk ?? 50;
    this.maxConsecutiveOpens = options.maxConsecutiveOpens ?? 5;
    this.breakerBaseMs = options.breakerBaseMs ?? 60_000;
    this.breakerCapMs = options.breakerCapMs ?? 600_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async ensure(site: string, config: ThrottleConfig): Promise<void> {
    await this.db.query(
      `INSERT INTO juris.site_throttle
         (site, tokens, capacity, refill_per_sec, concurrency, concurrency_min, concurrency_max)
       VALUES ($1, $2, $2, $3, $4, $5, $6)
       ON CONFLICT (site) DO NOTHING`,
      [
        site,
        config.burst,
        config.ratePerSec,
        config.concurrency,
        config.concurrencyMin,
        config.concurrencyMax,
      ],
    );
  }

  async acquire(site: string, signal?: AbortSignal): Promise<ThrottleLease> {
    for (;;) {
      if (signal?.aborted === true) throw new Error('throttle acquisition aborted');

      const { rows } = await this.db.query<{ concurrency: number; in_flight: number }>(
        `UPDATE juris.site_throttle SET
           tokens = LEAST(capacity, tokens + refill_per_sec * EXTRACT(EPOCH FROM now() - updated_at)) - 1,
           in_flight = in_flight + 1,
           updated_at = now()
         WHERE site = $1
           AND breaker_state <> 'OPEN'
           AND COALESCE(retry_after_until, now()) <= now()
           AND in_flight < concurrency
           AND LEAST(capacity, tokens + refill_per_sec * EXTRACT(EPOCH FROM now() - updated_at)) >= 1
         RETURNING concurrency, in_flight`,
        [site],
      );

      if (rows.length > 0) {
        let released = false;
        return {
          release: async () => {
            // Guarded, because a double release would let one more request through than the
            // configured concurrency allows, silently and permanently.
            if (released) return;
            released = true;
            await this.db.query(
              `UPDATE juris.site_throttle
                 SET in_flight = GREATEST(0, in_flight - 1), updated_at = now()
               WHERE site = $1`,
              [site],
            );
          },
        };
      }

      // Nothing available. Refuse to spin: the wait is what makes this polite.
      const snapshot = await this.snapshot(site);
      if (snapshot.breakerState === 'OPEN') {
        const until = snapshot.breakerUntil === null ? 0 : Date.parse(snapshot.breakerUntil);
        const wait = Math.max(this.retryDelayMs, until - this.now());
        await this.sleep(Math.min(wait, 30_000), signal);
      } else {
        await this.sleep(this.retryDelayMs, signal);
      }
    }
  }

  /**
   * Feeds the control law.
   *
   * On success: count it, and every `increaseAfterOk` successes let the concurrency creep up by
   * one, never past the configured ceiling.
   *
   * On rate limiting: halve the concurrency and the refill rate immediately, and honour any
   * `Retry-After` by refusing every acquisition until it passes. This is what makes a 429 felt by
   * **all** the workers rather than only by the one that received it.
   */
  async reportOutcome(
    site: string,
    outcome: FailureClass | 'OK',
    hints: { retryAfterMs?: number | null } = {},
  ): Promise<void> {
    this.cache.delete(site);

    if (outcome === 'OK') {
      // One assignment per column: Postgres refuses an UPDATE that sets the same column twice,
      // so the streak is reset and the concurrency raised from the *same* expression rather
      // than from two. Every reference reads the pre-update value, which is what makes the
      // whole decision atomic.
      await this.db.query(
        `UPDATE juris.site_throttle SET
           concurrency = CASE
             WHEN ok_streak + 1 >= $2 THEN LEAST(concurrency_max, concurrency + 1)
             ELSE concurrency END,
           ok_streak = CASE WHEN ok_streak + 1 >= $2 THEN 0 ELSE ok_streak + 1 END,
           breaker_state = CASE WHEN breaker_state = 'HALF_OPEN' THEN 'CLOSED' ELSE breaker_state END,
           breaker_opens = CASE WHEN breaker_state = 'HALF_OPEN' THEN 0 ELSE breaker_opens END,
           updated_at = now()
         WHERE site = $1`,
        [site, this.increaseAfterOk],
      );
      return;
    }

    if (outcome === 'RATE_LIMITED') {
      const retryAfterSeconds =
        hints.retryAfterMs === null || hints.retryAfterMs === undefined
          ? null
          : hints.retryAfterMs / 1000;
      await this.db.query(
        `UPDATE juris.site_throttle SET
           concurrency = GREATEST(concurrency_min, concurrency / 2),
           refill_per_sec = GREATEST(0.1, refill_per_sec / 2),
           ok_streak = 0,
           last_429_at = now(),
           retry_after_until = CASE
             WHEN $2::numeric IS NULL THEN retry_after_until
             ELSE now() + make_interval(secs => $2::numeric) END,
           updated_at = now()
         WHERE site = $1`,
        [site, retryAfterSeconds],
      );
      return;
    }

    // Other failures reset the success streak but do not move the concurrency: a parse error
    // says nothing about how much traffic the server wants.
    await this.db.query(
      `UPDATE juris.site_throttle SET ok_streak = 0, updated_at = now() WHERE site = $1`,
      [site],
    );
  }

  /**
   * Opens the breaker.
   *
   * Each consecutive opening doubles the wait, and after `maxConsecutiveOpens` the run is
   * abandoned rather than continuing to knock. Five failed recoveries is a site that is down or
   * a client that is banned, and neither is improved by more requests.
   */
  async openBreaker(site: string, reason: string): Promise<void> {
    const { rows } = await this.db.query<{ breaker_opens: number }>(
      `UPDATE juris.site_throttle SET
         breaker_state = 'OPEN',
         breaker_opens = breaker_opens + 1,
         breaker_until = now() + make_interval(secs => LEAST($2::numeric,
           $3::numeric * power(2, LEAST(breaker_opens, 10))) / 1000),
         concurrency = concurrency_min,
         ok_streak = 0,
         updated_at = now()
       WHERE site = $1
       RETURNING breaker_opens`,
      [site, this.breakerCapMs, this.breakerBaseMs],
    );
    this.cache.delete(site);

    const opens = rows[0]?.breaker_opens ?? 0;
    if (Number(opens) >= this.maxConsecutiveOpens) {
      throw new BreakerAbort(
        Number(opens),
        `the circuit breaker for ${site} has opened ${String(opens)} times without recovering ` +
          `(${reason}). The site is down or this client is blocked; the run stops with its state ` +
          `intact and can be resumed.`,
      );
    }
  }

  /** Lets one probe request through once the open period has elapsed. */
  async halfOpenIfDue(site: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE juris.site_throttle
         SET breaker_state = 'HALF_OPEN', updated_at = now()
       WHERE site = $1 AND breaker_state = 'OPEN' AND breaker_until <= now()
       RETURNING site`,
      [site],
    );
    if (rows.length > 0) this.cache.delete(site);
    return rows.length > 0;
  }

  async snapshot(site: string): Promise<ThrottleSnapshot> {
    const cached = this.cache.get(site);
    if (cached !== undefined && this.now() - cached.at < this.cacheMs) return cached.snapshot;

    const { rows } = await this.db.query(`SELECT * FROM juris.site_throttle WHERE site = $1`, [
      site,
    ]);
    const row = rows[0];
    if (row === undefined) throw new Error(`no throttle row for site ${site}; call ensure() first`);

    const snapshot: ThrottleSnapshot = {
      concurrency: readNumber(row, 'concurrency'),
      inFlight: readNumber(row, 'in_flight'),
      tokens: readNumber(row, 'tokens'),
      refillPerSec: readNumber(row, 'refill_per_sec'),
      breakerState: readString(row, 'breaker_state') as ThrottleSnapshot['breakerState'],
      breakerUntil: readTimestampOrNull(row, 'breaker_until'),
      retryAfterUntil: readTimestampOrNull(row, 'retry_after_until'),
    };
    this.cache.set(site, { at: this.now(), snapshot });
    return snapshot;
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
