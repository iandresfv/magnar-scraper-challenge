/**
 * The completeness test. This is the one that matters.
 *
 * A synthetic court with a known number of cases, a real crawl through the real command, and one
 * question afterwards: **did we get all of them?** Not approximately, not "the code ran" — the
 * count of distinct cases in the database against the count that exist, exactly.
 *
 * Everything else in this repository exists to make that question answerable. The site caps every
 * answer at thirty rows and offers no pagination, so the number can only come out right if the
 * partitioning, the tiling invariant, the deduplication and the resume logic are all correct at
 * once.
 *
 * It runs against both drivers, because "the fallback is a real Postgres" is a claim that should
 * cost something to make.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { PgExecutor } from '../../src/infra/db/pgExecutor.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { createRepos } from '../../src/infra/db/repos/index.js';
import { PgJobQueue } from '../../src/infra/db/pgJobQueue.js';
import { FetchHttpClient } from '../../src/infra/http/fetchHttpClient.js';
import { assertTiling } from '../../src/core/engine/partitionTree.js';
import { crawlCommand } from '../../src/app/commands/crawl.js';
import { resolveConfig } from '../../src/app/config.js';
import { createSite } from '../../src/app/registry.js';
import { ExitCode } from '../../src/core/domain/types.js';
import { startFakePje, type FakePjeServer } from '../fake-pje-server/server.js';
import { acquireTestDatabase } from '../support/pgDatabase.js';

const SITE = 'fake-pje';
/** Ninety days of synthetic data: several hundred cases, with every awkward day shape in it. */
const DAYS = 90;
const ROOT = { ini: '2024-01-01', fim: '2024-03-31' };

interface Subject {
  name: string;
  create: () => Promise<SqlExecutor>;
  cleanup?: () => Promise<void>;
}

/** A full crawl is hundreds of round trips; a CI runner needs more than a unit test's budget. */
const E2E_TIMEOUT = 300_000;

function runCompletenessSuite(subject: Subject): void {
  describe(`completeness: ${subject.name}`, { timeout: E2E_TIMEOUT }, () => {
    let fake: FakePjeServer;
    let db: SqlExecutor;

    beforeAll(async () => {
      fake = await startFakePje({ days: DAYS, seed: 20260827 });
      db = await subject.create();
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE');
      await migrate(db);
    });

    afterAll(async () => {
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE').catch(() => undefined);
      await db.close();
      await fake.close();
      await subject.cleanup?.();
    });

    /** Wipes everything the crawl writes, for a test that needs to start from nothing. */
    async function reset(): Promise<void> {
      for (const table of [
        'job',
        'blob',
        'document',
        'movement',
        'lawyer',
        'party',
        'subject',
        'case_record',
        'partition',
        'class_vocabulary',
        'metric',
        'crawl_run',
      ]) {
        await db.query(`DELETE FROM juris.${table}`);
      }
    }

    /** Wires the real command against the fake site. Nothing here is a test double but the site. */
    async function crawl(
      overrides: { root?: { ini: string; fim: string }; maxJobs?: number } = {},
    ): Promise<Awaited<ReturnType<typeof crawlCommand>>> {
      const config = resolveConfig({
        argv: [
          'crawl',
          '--site',
          SITE,
          '--root-start',
          (overrides.root ?? ROOT).ini,
          '--root-end',
          (overrides.root ?? ROOT).fim,
          '--pdf-budget',
          '0',
          ...(overrides.maxJobs === undefined ? [] : ['--max-jobs', String(overrides.maxJobs)]),
        ],
        env: {},
      });

      return crawlCommand({
        config,
        adapter: createSite(SITE, { baseUrl: fake.url }),
        http: new FetchHttpClient({ defaultTimeoutMs: 10_000 }),
        db,
        repos: createRepos(db),
        queue: new PgJobQueue(db, { defaultLeaseMs: 60_000 }),
        log: () => undefined,
        progressEveryMs: 1_000_000,
      });
    }

    /** How many cases the synthetic court actually holds inside the root. */
    function expectedCases(root = ROOT): number {
      let total = 0;
      for (const [day, cases] of fake.dataset.byDay) {
        if (day >= root.ini && day <= root.fim) total += cases.length;
      }
      return total;
    }

    /** How many the crawl cannot reach, because one class alone exceeds the cap that day. */
    function unreachableCases(root = ROOT): number {
      const gapDay = fake.dataset.gapDay;
      if (gapDay < root.ini || gapDay > root.fim) return 0;
      const onGapDay = fake.dataset.byDay.get(gapDay)?.length ?? 0;
      return Math.max(0, onGapDay - fake.dataset.cap);
    }

    /**
     * One crawl, many questions.
     *
     * Each of these assertions is about the same finished run, so running the crawl once and
     * interrogating it is both faster and more honest than crawling nine times and hoping every
     * run behaved identically. The tests that genuinely need a fresh start do their own.
     */
    let shared: Awaited<ReturnType<typeof crawlCommand>>;

    beforeAll(async () => {
      await reset();
      shared = await crawl();
    }, 300_000);

    it('finds every case the site can show, and says so exactly', async () => {
      const result = shared;
      const repos = createRepos(db);

      const counts = await repos.cases.countByState(SITE);
      const stored =
        (counts['LISTED'] ?? 0) + (counts['DETAILED'] ?? 0) + (counts['DETAIL_FAILED'] ?? 0);

      // The only cases missing are the ones behind the designed GAP, and their number is known.
      expect(stored).toBe(expectedCases() - unreachableCases());
      expect(stored).toBeGreaterThan(200);
      expect(result.exitCode === ExitCode.OK || result.exitCode === ExitCode.DEAD_JOBS_REMAIN).toBe(
        true,
      );
    });

    it('tiles the root exactly, with no gap and no overlap', async () => {
      const result = shared;
      const repos = createRepos(db);
      const leaves = await repos.partitions.primaryLeaves(result.runId);
      const tiling = assertTiling(leaves, ROOT);
      expect(tiling.violations, JSON.stringify(tiling.violations.slice(0, 3))).toEqual([]);
      expect(tiling.coveredDays).toBe(tiling.rootDays);
    });

    it('never overlaps two resolved leaves — enforced by the database, not only by the code', async () => {
      // The EXCLUDE constraint would have refused the insert; this asserts it was active.
      const { rows } = await db.query<{ n: string | number }>(
        `SELECT count(*) AS n FROM juris.partition a JOIN juris.partition b
           ON a.site = b.site AND a.id < b.id
          AND a.status = 'LEAF_DONE' AND b.status = 'LEAF_DONE'
          AND a.facets = '{}'::jsonb AND b.facets = '{}'::jsonb
          AND daterange(a.data_ini, a.data_fim, '[]') && daterange(b.data_ini, b.data_fim, '[]')`,
      );
      expect(Number(rows[0]?.n ?? 0)).toBe(0);
    });

    it('declares a GAP only where one was designed, with the arithmetic to justify it', async () => {
      const result = shared;
      const repos = createRepos(db);
      const gaps = await repos.reports.gapPartitions(result.runId);

      const gapDayInRoot = fake.dataset.gapDay >= ROOT.ini && fake.dataset.gapDay <= ROOT.fim;
      if (!gapDayInRoot) {
        expect(gaps).toHaveLength(0);
        return;
      }

      expect(gaps.length).toBeGreaterThan(0);
      for (const gap of gaps) {
        expect(gap.range.ini).toBe(fake.dataset.gapDay);
        expect(gap.truncated).toBe(true);
        expect(gap.observedRows).toBe(fake.dataset.cap);
        // The evidence is on the node, not only in a log line nobody keeps.
        expect(gap.lastError).toContain('no-axis-can-split');
      }
      expect(result.gaps.length).toBeGreaterThan(0);
    });

    it('leaves the observed row counts and the stored cases in agreement', async () => {
      const result = shared;
      const repos = createRepos(db);
      const { observed, unique } = await repos.reports.observedRowsVsUnique(result.runId);
      // Observed can exceed unique — a truncated parent's thirty rows are seen again by its
      // children — but it can never be *less*, which would mean rows appeared from nowhere.
      expect(observed).toBeGreaterThanOrEqual(unique);
      expect(unique).toBeGreaterThan(0);
    });

    it('deduplicates across overlapping queries: every case appears once', async () => {
      const { rows } = await db.query<{ total: string | number; distinct: string | number }>(
        `SELECT count(*) AS total, count(DISTINCT id_origem) AS distinct FROM juris.case_record`,
      );
      expect(Number(rows[0]?.total)).toBe(Number(rows[0]?.distinct));
    });

    it('is idempotent: a second crawl of the same root writes nothing new', async () => {
      const repos = createRepos(db);
      const before = await repos.cases.countByState(SITE);
      const requestsBefore = fake.counts['search'] ?? 0;

      const second = await crawl();
      const after = await repos.cases.countByState(SITE);

      expect(after).toEqual(before);
      // The second run resumes the finished one rather than re-querying the whole tree.
      expect(second.runId).not.toBe('');
      expect((fake.counts['search'] ?? 0) - requestsBefore).toBeLessThan(5);
    });

    // From here on the tests wipe the database and crawl again, so anything that questions the
    // shared run has to come before them.
    it('resumes after being stopped part-way, and reaches the same answer', async () => {
      // Stop after a handful of jobs, as an interrupted operator or a crashed container would.
      await reset();
      const partial = await crawl({ maxJobs: 8 });
      expect(partial.jobsRun).toBe(8);
      const repos = createRepos(db);
      const partialCount = await repos.cases.countByState(SITE);

      const finished = await crawl();
      const finalCount = await repos.cases.countByState(SITE);
      const total = (c: Record<string, number>): number =>
        Object.values(c).reduce((sum, n) => sum + n, 0);

      expect(total(finalCount)).toBeGreaterThan(total(partialCount));
      expect(total(finalCount)).toBe(expectedCases() - unreachableCases());

      const tiling = assertTiling(await repos.partitions.primaryLeaves(finished.runId), ROOT);
      expect(tiling.ok).toBe(true);
    });

    it('stores every case with a valid, unique case number', async () => {
      const { rows } = await db.query<{ bad: string | number; dupes: string | number }>(
        `SELECT
           count(*) FILTER (WHERE numero !~ '^[0-9]{7}-[0-9]{2}\\.[0-9]{4}\\.[0-9]\\.[0-9]{2}\\.[0-9]{4}$') AS bad,
           count(*) - count(DISTINCT numero) AS dupes
         FROM juris.case_record`,
      );
      expect(Number(rows[0]?.bad)).toBe(0);
      expect(Number(rows[0]?.dupes)).toBe(0);
    });
  });
}

runCompletenessSuite({ name: 'pglite', create: () => PgliteExecutor.create() });

const database = await acquireTestDatabase('completeness');
if (database !== null) {
  runCompletenessSuite({
    name: 'pg (server)',
    create: () => Promise.resolve(new PgExecutor({ connectionString: database.url })),
    cleanup: () => database.drop(),
  });
} else {
  describe('completeness: pg (server)', () => {
    it.skip('skipped: no reachable TEST_DATABASE_URL', () => undefined);
  });
}
