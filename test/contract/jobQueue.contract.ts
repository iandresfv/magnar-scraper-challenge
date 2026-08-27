/**
 * The job queue contract.
 *
 * The assertion that earns its place is the concurrent one: three consumers racing for the same
 * jobs must between them claim each job exactly once. Everything else in the resume-and-scale
 * story rests on that, and it is not something a single-threaded test can demonstrate — which is
 * why it runs against a real server, where `SKIP LOCKED` has something to skip.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { PgJobQueue, PRIORITY } from '../../src/infra/db/pgJobQueue.js';

export interface JobQueueSubject {
  name: string;
  create: () => Promise<SqlExecutor>;
  /** True when the driver supports more than one connection, so racing is meaningful. */
  concurrent: boolean;
}

const SITE = 'br-trf5';

export function runJobQueueContract(subject: JobQueueSubject): void {
  describe(`job queue: ${subject.name}`, () => {
    let db: SqlExecutor;
    let queue: PgJobQueue;

    beforeAll(async () => {
      db = await subject.create();
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE');
      await migrate(db);
      await db.query(
        `INSERT INTO juris.site (id, country, name, base_url, timezone)
         VALUES ($1,'BR','TRF5','https://x','America/Recife') ON CONFLICT DO NOTHING`,
        [SITE],
      );
      queue = new PgJobQueue(db, { defaultLeaseMs: 60_000 });
    });

    afterAll(async () => {
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE').catch(() => undefined);
      await db.close();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM juris.job');
    });

    const seed = async (
      n: number,
      kind: 'search' | 'detail' | 'blob' = 'detail',
    ): Promise<void> => {
      await queue.enqueue(
        Array.from({ length: n }, (_, i) => ({
          site: SITE,
          kind,
          key: `${kind}:${String(i)}`,
          payload: { i },
        })),
      );
    };

    describe('enqueue', () => {
      it('inserts new work and reports how much was new', async () => {
        expect(await queue.enqueue([{ site: SITE, kind: 'detail', key: 'd:1', payload: {} }])).toBe(
          1,
        );
      });

      it('is idempotent on (site, key), so re-seeding is free', async () => {
        await queue.enqueue([{ site: SITE, kind: 'detail', key: 'd:1', payload: {} }]);
        expect(await queue.enqueue([{ site: SITE, kind: 'detail', key: 'd:1', payload: {} }])).toBe(
          0,
        );
        expect((await queue.stats(SITE)).pending).toBe(1);
      });

      it('tolerates an empty batch', async () => {
        expect(await queue.enqueue([])).toBe(0);
      });

      it('defaults priority by kind, so a leaf finishes before another starts', async () => {
        await queue.enqueue([
          { site: SITE, kind: 'blob', key: 'b:1', payload: {} },
          { site: SITE, kind: 'search', key: 's:1', payload: {} },
          { site: SITE, kind: 'detail', key: 'd:1', payload: {} },
        ]);
        const order: string[] = [];
        for (let i = 0; i < 3; i++) {
          const job = await queue.lease(SITE, 'w', 60_000);
          if (job !== null) order.push(job.kind);
        }
        expect(order).toEqual(['search', 'detail', 'blob']);
        expect(PRIORITY.search).toBeLessThan(PRIORITY.detail);
      });

      it('honours a future run_after, so a delayed retry is not claimed early', async () => {
        await queue.enqueue([
          {
            site: SITE,
            kind: 'detail',
            key: 'later',
            payload: {},
            runAfter: new Date(Date.now() + 60_000),
          },
        ]);
        expect(await queue.lease(SITE, 'w', 60_000)).toBeNull();
      });

      it('can join the transaction of its caller, so data and work commit together', async () => {
        await db
          .transaction(async (tx) => {
            await queue.enqueue([{ site: SITE, kind: 'detail', key: 'tx:1', payload: {} }], tx);
            throw new Error('rolled back');
          })
          .catch(() => undefined);
        expect((await queue.stats(SITE)).pending).toBe(0);
      });
    });

    describe('lease', () => {
      it('returns null when there is nothing to do', async () => {
        expect(await queue.lease(SITE, 'w', 60_000)).toBeNull();
      });

      it('claims a job, stamps it, and counts the attempt', async () => {
        await seed(1);
        const job = await queue.lease(SITE, 'worker-1', 60_000);
        expect(job?.status).toBe('leased');
        expect(job?.leasedBy).toBe('worker-1');
        expect(job?.attempts).toBe(1);
        expect(job?.payload).toEqual({ i: 0 });
      });

      it('does not hand the same job to a second caller', async () => {
        await seed(1);
        expect(await queue.lease(SITE, 'a', 60_000)).not.toBeNull();
        expect(await queue.lease(SITE, 'b', 60_000)).toBeNull();
      });

      it('ignores jobs belonging to another site', async () => {
        await db.query(
          `INSERT INTO juris.site (id, country, name, base_url, timezone)
           VALUES ('other','BR','x','https://x','America/Recife') ON CONFLICT DO NOTHING`,
        );
        await queue.enqueue([{ site: 'other', kind: 'detail', key: 'd:1', payload: {} }]);
        expect(await queue.lease(SITE, 'w', 60_000)).toBeNull();
      });
    });

    describe('completion and failure', () => {
      it('marks a job done', async () => {
        await seed(1);
        const job = await queue.lease(SITE, 'w', 60_000);
        if (job === null) throw new Error('nothing leased');
        await queue.complete(job.id);
        const stats = await queue.stats(SITE);
        expect(stats.done).toBe(1);
        expect(stats.pending).toBe(0);
      });

      it('retries with a delay, and the job is not claimable until it elapses', async () => {
        await seed(1);
        const job = await queue.lease(SITE, 'w', 60_000);
        if (job === null) throw new Error('nothing leased');
        expect(
          await queue.retry(job.id, 60_000, { failureClass: 'SERVER_ERROR', error: '503' }),
        ).toBe('retried');
        expect(await queue.lease(SITE, 'w', 60_000)).toBeNull();
      });

      it('makes it claimable again once the delay has passed', async () => {
        await seed(1);
        const job = await queue.lease(SITE, 'w', 60_000);
        if (job === null) throw new Error('nothing leased');
        await queue.retry(job.id, 0, { failureClass: 'SERVER_ERROR', error: '503' });
        const again = await queue.lease(SITE, 'w', 60_000);
        expect(again?.id).toBe(job.id);
        expect(again?.attempts).toBe(2);
      });

      it('goes dead once attempts reach the maximum, in one atomic decision', async () => {
        await queue.enqueue([
          { site: SITE, kind: 'detail', key: 'd:1', payload: {}, maxAttempts: 2 },
        ]);
        for (let i = 0; i < 2; i++) {
          const job = await queue.lease(SITE, 'w', 60_000);
          if (job === null) throw new Error('nothing leased');
          const outcome = await queue.retry(job.id, 0, {
            failureClass: 'RATE_LIMITED',
            error: '429',
            httpStatus: 429,
          });
          if (i === 1) expect(outcome).toBe('dead');
        }
        expect((await queue.stats(SITE)).dead).toBe(1);
        expect(await queue.lease(SITE, 'w', 60_000)).toBeNull();
      });

      it('records why a job died, so the DLQ is diagnosable', async () => {
        await seed(1);
        const job = await queue.lease(SITE, 'w', 60_000);
        if (job === null) throw new Error('nothing leased');
        await queue.dead(job.id, {
          failureClass: 'NOT_PDF',
          error: 'body was HTML',
          httpStatus: 200,
        });
        const [dead] = await queue.listDead(SITE, {});
        expect(dead?.failureClass).toBe('NOT_PDF');
        expect(dead?.lastError).toBe('body was HTML');
        expect(dead?.httpStatus).toBe(200);
      });
    });

    describe('lease expiry — the resume story', () => {
      it('recovers a job whose worker died', async () => {
        await seed(1);
        // A lease that has already expired stands in for a worker killed mid-job.
        const job = await queue.lease(SITE, 'doomed', 1);
        if (job === null) throw new Error('nothing leased');
        await db.query(`UPDATE juris.job SET lease_until = now() - interval '1 second'`);

        expect(await queue.reapExpiredLeases(SITE)).toBe(1);
        const recovered = await queue.lease(SITE, 'survivor', 60_000);
        expect(recovered?.id).toBe(job.id);
        expect(recovered?.leasedBy).toBe('survivor');
      });

      it('leaves a live lease alone', async () => {
        await seed(1);
        await queue.lease(SITE, 'busy', 60_000);
        expect(await queue.reapExpiredLeases(SITE)).toBe(0);
      });

      it('keeps the attempt count, so a job that kills workers eventually dies', async () => {
        await queue.enqueue([
          { site: SITE, kind: 'detail', key: 'poison', payload: {}, maxAttempts: 3 },
        ]);
        await queue.lease(SITE, 'w1', 1);
        await db.query(`UPDATE juris.job SET lease_until = now() - interval '1 second'`);
        await queue.reapExpiredLeases(SITE);
        const again = await queue.lease(SITE, 'w2', 60_000);
        expect(again?.attempts).toBe(2);
      });
    });

    describe('the dead letter queue', () => {
      beforeEach(async () => {
        await seed(3, 'blob');
        for (let i = 0; i < 3; i++) {
          const job = await queue.lease(SITE, 'w', 60_000);
          if (job !== null) await queue.dead(job.id, { failureClass: 'NOT_PDF', error: 'x' });
        }
      });

      it('lists what died', async () => {
        expect(await queue.listDead(SITE, {})).toHaveLength(3);
      });

      it('filters by kind', async () => {
        expect(await queue.listDead(SITE, { kind: 'detail' })).toHaveLength(0);
        expect(await queue.listDead(SITE, { kind: 'blob' })).toHaveLength(3);
      });

      it('revives them with their attempt counters reset', async () => {
        expect(await queue.revive(SITE, {})).toBe(3);
        const stats = await queue.stats(SITE);
        expect(stats.dead).toBe(0);
        expect(stats.pending).toBe(3);
        const job = await queue.lease(SITE, 'w', 60_000);
        expect(job?.attempts).toBe(1);
        expect(job?.failureClass).toBeNull();
      });

      it('can revive a bounded number, for a cautious retry', async () => {
        expect(await queue.revive(SITE, { limit: 2 })).toBe(2);
        expect((await queue.stats(SITE)).dead).toBe(1);
      });
    });

    describe('stats', () => {
      it('reports totals and a breakdown by kind', async () => {
        await seed(2, 'search');
        await seed(3, 'blob');
        const leased = await queue.lease(SITE, 'w', 60_000);
        if (leased !== null) await queue.complete(leased.id);

        const stats = await queue.stats(SITE);
        expect(stats.done).toBe(1);
        expect(stats.pending).toBe(4);
        expect(stats.byKind['blob']?.pending).toBe(3);
        expect(stats.byKind['search']?.pending).toBe(1);
      });
    });

    if (subject.concurrent) {
      describe('concurrency — the property the whole scaling story rests on', () => {
        it('gives each job to exactly one of three racing consumers', async () => {
          const total = 60;
          await seed(total);

          // Three workers claiming as fast as they can, interleaved rather than in phases, so
          // the race is real.
          const claim = async (worker: string): Promise<string[]> => {
            const mine: string[] = [];
            for (;;) {
              const job = await queue.lease(SITE, worker, 60_000);
              if (job === null) return mine;
              mine.push(job.id);
              await queue.complete(job.id);
            }
          };
          const claimed = (await Promise.all([claim('w1'), claim('w2'), claim('w3')])).flat();

          expect(claimed).toHaveLength(total);
          expect(new Set(claimed).size).toBe(total);
          const stats = await queue.stats(SITE);
          expect(stats.done).toBe(total);
          expect(stats.pending).toBe(0);
        });

        it('spreads the work rather than starving two of the three', async () => {
          await seed(60);
          const counts: Record<string, number> = { w1: 0, w2: 0, w3: 0 };
          const claim = async (worker: string): Promise<void> => {
            for (;;) {
              const job = await queue.lease(SITE, worker, 60_000);
              if (job === null) return;
              counts[worker] = (counts[worker] ?? 0) + 1;
              await queue.complete(job.id);
            }
          };
          await Promise.all([claim('w1'), claim('w2'), claim('w3')]);
          // Not a fairness guarantee — SKIP LOCKED makes none — but every worker should get work.
          expect(Object.values(counts).filter((n) => n > 0).length).toBeGreaterThanOrEqual(2);
        });
      });
    }
  });
}
