/**
 * The shared throttle contract.
 *
 * The assertion this file exists for is the concurrency one: several independent callers racing
 * for slots must never, at any instant, have more requests in flight than the row allows. That
 * is the property that makes `--scale worker=N` a claim about throughput rather than about how
 * hard a court gets hit, and it is only meaningful against a real server where the callers are
 * genuinely concurrent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { PgThrottle } from '../../src/infra/db/pgThrottle.js';
import { BreakerAbort } from '../../src/core/ports/throttle.js';

export interface ThrottleSubject {
  name: string;
  create: () => Promise<SqlExecutor>;
  /** Whether the driver supports genuinely concurrent callers. */
  concurrent: boolean;
}

const SITE = 'br-trf5';

export function runThrottleContract(subject: ThrottleSubject): void {
  describe(`shared throttle: ${subject.name}`, () => {
    let db: SqlExecutor;

    beforeAll(async () => {
      db = await subject.create();
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE');
      await migrate(db);
      await db.query(
        `INSERT INTO juris.site (id, country, name, base_url, timezone)
         VALUES ($1,'BR','TRF5','https://x','America/Recife') ON CONFLICT DO NOTHING`,
        [SITE],
      );
    });

    afterAll(async () => {
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE').catch(() => undefined);
      await db.close();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM juris.site_throttle');
    });

    /** A throttle with a generous token supply, so tests exercise concurrency not the bucket. */
    async function throttle(
      config: Partial<Parameters<PgThrottle['ensure']>[1]> = {},
      options: ConstructorParameters<typeof PgThrottle>[1] = {},
    ): Promise<PgThrottle> {
      const instance = new PgThrottle(db, { retryDelayMs: 5, cacheMs: 0, ...options });
      await instance.ensure(SITE, {
        concurrency: 4,
        concurrencyMin: 1,
        concurrencyMax: 8,
        ratePerSec: 1_000,
        burst: 1_000,
        ...config,
      });
      return instance;
    }

    describe('setup', () => {
      it('creates the row once and leaves an existing one alone', async () => {
        const first = await throttle({ concurrency: 4 });
        await first.ensure(SITE, {
          concurrency: 7,
          concurrencyMin: 1,
          concurrencyMax: 8,
          ratePerSec: 1,
          burst: 1,
        });
        expect((await first.snapshot(SITE)).concurrency).toBe(4);
      });

      it('starts at the configured concurrency', async () => {
        const t = await throttle({ concurrency: 4 });
        const snapshot = await t.snapshot(SITE);
        expect(snapshot.concurrency).toBe(4);
        expect(snapshot.inFlight).toBe(0);
        expect(snapshot.breakerState).toBe('CLOSED');
      });
    });

    describe('acquisition', () => {
      it('hands out a slot and takes it back', async () => {
        const t = await throttle();
        const lease = await t.acquire(SITE);
        expect((await t.snapshot(SITE)).inFlight).toBe(1);
        await lease.release();
        expect((await t.snapshot(SITE)).inFlight).toBe(0);
      });

      it('ignores a second release, which would otherwise let an extra request through', async () => {
        const t = await throttle();
        const lease = await t.acquire(SITE);
        await lease.release();
        await lease.release();
        expect((await t.snapshot(SITE)).inFlight).toBe(0);
      });

      it('spends a token per acquisition', async () => {
        const t = await throttle({ ratePerSec: 0.001, burst: 3 });
        const before = (await t.snapshot(SITE)).tokens;
        const lease = await t.acquire(SITE);
        expect((await t.snapshot(SITE)).tokens).toBeLessThan(before);
        await lease.release();
      });

      it('makes a caller wait when the concurrency is full', async () => {
        const t = await throttle({ concurrency: 1 });
        const first = await t.acquire(SITE);

        let acquired = false;
        const second = t.acquire(SITE).then((lease) => {
          acquired = true;
          return lease;
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(acquired).toBe(false);

        await first.release();
        await (await second).release();
        expect(acquired).toBe(true);
      });

      it('refuses everything while a Retry-After is in force', async () => {
        // The measured consequence of a 429: every worker waits, not only the one that got it.
        const t = await throttle();
        await t.reportOutcome(SITE, 'RATE_LIMITED', { retryAfterMs: 30_000 });
        expect((await t.snapshot(SITE)).retryAfterUntil).not.toBeNull();

        // Aborted at the end: an acquisition that is never satisfied and never cancelled keeps
        // polling forever and will starve the connection pool for every later test.
        const controller = new AbortController();
        let acquired = false;
        const pending = t
          .acquire(SITE, controller.signal)
          .then(() => (acquired = true))
          .catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(acquired).toBe(false);
        controller.abort();
        await pending;
      });

      it('can be aborted rather than waiting forever', async () => {
        const t = await throttle({ concurrency: 1 });
        await t.acquire(SITE);
        const controller = new AbortController();
        const pending = t.acquire(SITE, controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow(/aborted/);
      });
    });

    describe('the control law', () => {
      it('creeps upward after a run of successes, never past the ceiling', async () => {
        const t = await throttle({ concurrency: 4, concurrencyMax: 6 }, { increaseAfterOk: 3 });
        for (let i = 0; i < 3; i++) await t.reportOutcome(SITE, 'OK');
        expect((await t.snapshot(SITE)).concurrency).toBe(5);

        for (let i = 0; i < 30; i++) await t.reportOutcome(SITE, 'OK');
        expect((await t.snapshot(SITE)).concurrency).toBe(6);
      });

      it('halves immediately on a 429 — fast down, slow up', async () => {
        const t = await throttle({ concurrency: 8, concurrencyMax: 8 });
        await t.reportOutcome(SITE, 'RATE_LIMITED');
        expect((await t.snapshot(SITE)).concurrency).toBe(4);
        await t.reportOutcome(SITE, 'RATE_LIMITED');
        expect((await t.snapshot(SITE)).concurrency).toBe(2);
      });

      it('never falls below the floor, so the crawl does not stall completely', async () => {
        const t = await throttle({ concurrency: 4, concurrencyMin: 1 });
        for (let i = 0; i < 10; i++) await t.reportOutcome(SITE, 'RATE_LIMITED');
        expect((await t.snapshot(SITE)).concurrency).toBe(1);
      });

      it('halves the refill rate too, not only the concurrency', async () => {
        const t = await throttle({ ratePerSec: 4 });
        await t.reportOutcome(SITE, 'RATE_LIMITED');
        expect((await t.snapshot(SITE)).refillPerSec).toBeCloseTo(2);
      });

      it('resets the success streak on an unrelated failure without moving the concurrency', async () => {
        // A parse error says nothing about how much traffic the server wants.
        const t = await throttle({ concurrency: 4 }, { increaseAfterOk: 3 });
        await t.reportOutcome(SITE, 'OK');
        await t.reportOutcome(SITE, 'OK');
        await t.reportOutcome(SITE, 'PARSE');
        await t.reportOutcome(SITE, 'OK');
        expect((await t.snapshot(SITE)).concurrency).toBe(4);
      });
    });

    describe('the circuit breaker', () => {
      it('opens, blocks acquisition, and reports when it will reconsider', async () => {
        const t = await throttle({}, { breakerBaseMs: 50_000 });
        await t.openBreaker(SITE, 'half the window failed');
        const snapshot = await t.snapshot(SITE);
        expect(snapshot.breakerState).toBe('OPEN');
        expect(snapshot.breakerUntil).not.toBeNull();
        expect(snapshot.concurrency).toBe(1);
      });

      it('lets exactly one probe through once the wait has elapsed', async () => {
        const t = await throttle({}, { breakerBaseMs: 1 });
        await t.openBreaker(SITE, 'x');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(await t.halfOpenIfDue(SITE)).toBe(true);
        expect((await t.snapshot(SITE)).breakerState).toBe('HALF_OPEN');
        // A second call finds nothing to do.
        expect(await t.halfOpenIfDue(SITE)).toBe(false);
      });

      it('closes on a successful probe and forgets the openings', async () => {
        const t = await throttle({}, { breakerBaseMs: 1 });
        await t.openBreaker(SITE, 'x');
        await new Promise((resolve) => setTimeout(resolve, 30));
        await t.halfOpenIfDue(SITE);
        await t.reportOutcome(SITE, 'OK');
        expect((await t.snapshot(SITE)).breakerState).toBe('CLOSED');
      });

      it('backs off further on each consecutive opening', async () => {
        const t = await throttle({}, { breakerBaseMs: 10_000, maxConsecutiveOpens: 99 });
        await t.openBreaker(SITE, 'x');
        const first = Date.parse((await t.snapshot(SITE)).breakerUntil ?? '');
        await t.openBreaker(SITE, 'x');
        const second = Date.parse((await t.snapshot(SITE)).breakerUntil ?? '');
        expect(second - first).toBeGreaterThan(5_000);
      });

      it('abandons the run after enough failed recoveries, rather than knocking forever', async () => {
        // Five failed recoveries is a site that is down or a client that is blocked.
        const t = await throttle({}, { maxConsecutiveOpens: 3, breakerBaseMs: 1 });
        await t.openBreaker(SITE, 'x');
        await t.openBreaker(SITE, 'x');
        await expect(t.openBreaker(SITE, 'still failing')).rejects.toBeInstanceOf(BreakerAbort);
      });

      it('says how to recover when it gives up', async () => {
        const t = await throttle({}, { maxConsecutiveOpens: 1, breakerBaseMs: 1 });
        const error = await t.openBreaker(SITE, 'x').catch((e: unknown) => e);
        expect((error as BreakerAbort).message).toContain('resumed');
        expect((error as BreakerAbort).message).toContain('state intact');
      });
    });

    if (subject.concurrent) {
      describe('the property that makes --scale safe', () => {
        it('never lets more requests in flight than the row allows, under a real race', async () => {
          const concurrency = 4;
          const t = await throttle({ concurrency, concurrencyMax: concurrency });

          let peak = 0;
          let current = 0;
          const worker = async (): Promise<void> => {
            for (let i = 0; i < 25; i++) {
              const lease = await t.acquire(SITE);
              current++;
              peak = Math.max(peak, current);
              // Long enough for the overlap to be real rather than theoretical.
              await new Promise((resolve) => setTimeout(resolve, 2));
              current--;
              await lease.release();
            }
          };

          await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);

          expect(peak).toBeLessThanOrEqual(concurrency);
          expect(peak).toBeGreaterThan(1);
          expect((await t.snapshot(SITE)).inFlight).toBe(0);
        });

        it('makes a 429 received by one caller felt by all of them', async () => {
          const t = await throttle({ concurrency: 8, concurrencyMax: 8 });
          const other = new PgThrottle(db, { retryDelayMs: 5, cacheMs: 0 });

          await t.reportOutcome(SITE, 'RATE_LIMITED');
          // A different instance, standing in for a different process.
          expect((await other.snapshot(SITE)).concurrency).toBe(4);
        });
      });
    }
  });
}
