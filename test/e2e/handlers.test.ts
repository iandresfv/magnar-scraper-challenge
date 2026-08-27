/**
 * The search and detail handlers, against the real pieces.
 *
 * PGlite, the real repositories, the real queue, the real adapter, and a real HTTP server. The
 * only thing that is not production is the site on the other end — which is the point: everything
 * between the job and the database is the code that ships.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { createRepos } from '../../src/infra/db/repos/index.js';
import { PgJobQueue } from '../../src/infra/db/pgJobQueue.js';
import { FetchHttpClient } from '../../src/infra/http/fetchHttpClient.js';
import { Pipeline } from '../../src/core/engine/pipeline.js';
import { SearchHandler } from '../../src/core/engine/handlers/search.js';
import { DetailHandler } from '../../src/core/engine/handlers/detail.js';
import { newPartitionNode } from '../../src/core/engine/partitionTree.js';
import { createSite } from '../../src/app/registry.js';
import { startFakePje, type FakePjeServer } from '../fake-pje-server/server.js';
import type { SiteAdapter, SiteSession } from '../../src/core/ports/siteAdapter.js';
import type { Job } from '../../src/core/ports/jobQueue.js';

const SITE = 'fake-pje';
const RUN_ID = '00000000-0000-4000-8000-0000000000ee';
const NOW = new Date('2026-08-27T13:00:00Z');

let fake: FakePjeServer;
let db: SqlExecutor;
let repos: ReturnType<typeof createRepos>;
let queue: PgJobQueue;
let adapter: SiteAdapter;
let session: SiteSession;
let http: FetchHttpClient;
let pipeline: Pipeline;

beforeAll(async () => {
  fake = await startFakePje({ days: 40, seed: 7 });
  db = await PgliteExecutor.create();
  await migrate(db);
  repos = createRepos(db);
  queue = new PgJobQueue(db, { defaultLeaseMs: 60_000 });
  http = new FetchHttpClient({ defaultTimeoutMs: 10_000 });
  adapter = createSite(SITE, { baseUrl: fake.url });
  session = await adapter.bootstrap(http);

  await repos.site.ensure({
    id: SITE,
    country: 'BR',
    name: 'fake',
    baseUrl: fake.url,
    timezone: 'America/Recife',
  });

  const searchHandler = new SearchHandler({
    adapter,
    db,
    queue,
    cases: repos.cases,
    partitions: repos.partitions,
    vocabulary: repos.vocabulary,
    session: () => Promise.resolve(session),
    http,
    now: () => NOW,
  });

  const detailHandler = new DetailHandler({
    adapter,
    http,
    db,
    queue,
    cases: repos.cases,
    blobs: repos.blobs,
    session: () => Promise.resolve(session),
    renewSession: async () => {
      session = await adapter.renew(http, session, 'SESSION_LOST');
      return session;
    },
    now: () => NOW,
    classify: (subject) => adapter.classify?.(subject as never) ?? null,
  });

  pipeline = new Pipeline().register(searchHandler).register(detailHandler);
});

afterAll(async () => {
  await db.close();
  await fake.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM juris.job');
  await db.query('DELETE FROM juris.blob');
  await db.query('DELETE FROM juris.case_record');
  await db.query('DELETE FROM juris.partition');
  await db.query('DELETE FROM juris.class_vocabulary');
  await db.query('DELETE FROM juris.crawl_run');
  await repos.runs.start({
    runId: RUN_ID,
    site: SITE,
    startedAt: NOW.toISOString(),
    finishedAt: null,
    root: { ini: '2024-01-01', fim: '2024-12-31' },
    config: {},
    version: 'test',
    exitCode: null,
    summary: null,
  });
});

/** Seeds a partition and its search job, the way the planner does. */
async function seedSearch(range: { ini: string; fim: string }): Promise<Job> {
  const node = newPartitionNode({
    site: SITE,
    runId: RUN_ID,
    range,
    now: NOW.toISOString(),
  });
  await repos.partitions.save(node);
  await queue.enqueue([
    {
      site: SITE,
      kind: 'search',
      key: `search:${node.id}`,
      payload: { partitionId: node.id, range, facets: {} },
    },
  ]);
  const job = await queue.lease(SITE, 'w', 60_000);
  if (job === null) throw new Error('nothing to lease');
  return job;
}

describe('the search handler', () => {
  it('resolves an untruncated partition and stores every row it saw', async () => {
    const job = await seedSearch({ ini: '2024-01-12', fim: '2024-01-12' });
    const outcome = await pipeline.run(job);

    expect(outcome.kind).toBe('done');
    const node = await repos.partitions.get(SITE, '2024-01-12..2024-01-12');
    expect(node?.status).toBe('LEAF_DONE');
    expect(node?.truncated).toBe(false);

    const counts = await repos.cases.countByState(SITE);
    expect(counts['LISTED']).toBe(node?.observedRows);
    expect(counts['LISTED']).toBeGreaterThan(0);
  });

  it('splits a truncated partition and enqueues its children', async () => {
    const job = await seedSearch({ ini: '2024-01-01', fim: '2024-03-01' });
    await pipeline.run(job);

    const parent = await repos.partitions.get(SITE, '2024-01-01..2024-03-01');
    expect(parent?.status).toBe('SPLIT');
    expect(parent?.truncated).toBe(true);
    expect(parent?.capSeen).toBe(30);

    const children = (await repos.partitions.listByRun(RUN_ID)).filter(
      (n) => n.parentId === parent?.id,
    );
    expect(children).toHaveLength(2);

    const stats = await queue.stats(SITE);
    expect(stats.byKind['search']?.pending).toBe(2);
  });

  it('enqueues a detail job for every row, even from a truncated page', async () => {
    // Thirty rows of a truncated page are real cases; they deserve their details either way.
    const job = await seedSearch({ ini: '2024-01-01', fim: '2024-03-01' });
    await pipeline.run(job);
    expect((await queue.stats(SITE)).byKind['detail']?.pending).toBe(30);
  });

  it('harvests the facet vocabulary as it goes', async () => {
    const job = await seedSearch({ ini: '2024-01-12', fim: '2024-01-12' });
    await pipeline.run(job);
    const vocabulary = await repos.vocabulary.values(SITE, 'classe');
    expect(vocabulary.length).toBeGreaterThan(0);
    expect(vocabulary.some((v) => v.includes('APELAÇÃO'))).toBe(true);
  });

  it('is idempotent: running the same job twice changes nothing', async () => {
    const job = await seedSearch({ ini: '2024-01-12', fim: '2024-01-12' });
    await pipeline.run(job);
    const first = await repos.cases.countByState(SITE);
    const firstStats = await queue.stats(SITE);

    // A resumed run re-leases the same job; the partition is already resolved.
    const outcome = await pipeline.run(job);
    expect(outcome.kind).toBe('done');
    expect(await repos.cases.countByState(SITE)).toEqual(first);
    expect((await queue.stats(SITE)).pending).toBe(firstStats.pending);
  });

  it('commits rows, partition and follow-up work together', async () => {
    // If they were separate writes, a crash between them would leave cases nobody will detail.
    const job = await seedSearch({ ini: '2024-01-12', fim: '2024-01-12' });
    await pipeline.run(job);

    const node = await repos.partitions.get(SITE, '2024-01-12..2024-01-12');
    const cases = await repos.cases.countByState(SITE);
    const stats = await queue.stats(SITE);
    expect(node?.observedRows).toBe(cases['LISTED']);
    expect(stats.byKind['detail']?.pending).toBe(cases['LISTED']);
  });

  it('buries a job whose partition is not in the tree', async () => {
    await queue.enqueue([
      {
        site: SITE,
        kind: 'search',
        key: 'search:ghost',
        payload: {
          partitionId: 'ghost',
          range: { ini: '2024-01-01', fim: '2024-01-01' },
          facets: {},
        },
      },
    ]);
    const job = await queue.lease(SITE, 'w', 60_000);
    if (job === null) throw new Error('nothing to lease');
    const outcome = await pipeline.run(job);
    expect(outcome.kind).toBe('dead');
  });
});

describe('the detail handler', () => {
  /** Runs a search, then leases and runs one of the detail jobs it produced. */
  async function firstDetail(): Promise<{
    job: Job;
    outcome: Awaited<ReturnType<Pipeline['run']>>;
  }> {
    const searchJob = await seedSearch({ ini: '2024-01-12', fim: '2024-01-12' });
    await pipeline.run(searchJob);
    await queue.complete(searchJob.id);

    const job = await queue.lease(SITE, 'w', 60_000);
    if (job === null || job.kind !== 'detail') throw new Error('expected a detail job');
    return { job, outcome: await pipeline.run(job) };
  }

  it('stores the full record with its children', async () => {
    const { job, outcome } = await firstDetail();
    expect(outcome.kind).toBe('done');

    const idOrigem = (job.payload as { idOrigem: string }).idOrigem;
    const record = await repos.cases.get(SITE, idOrigem);
    expect(record?.state).toBe('DETAILED');

    const children = await repos.cases.children(SITE, idOrigem);
    expect(children.partes.length).toBeGreaterThan(0);
    expect(children.movimentacoes.length).toBeGreaterThan(0);
  });

  it('registers every known document and enqueues a blob job for each', async () => {
    const { job } = await firstDetail();
    const idOrigem = (job.payload as { idOrigem: string }).idOrigem;

    const blobs = await repos.blobs.countByState(SITE);
    expect(blobs['PENDING']).toBeGreaterThan(0);
    expect((await queue.stats(SITE)).byKind['blob']?.pending).toBe(blobs['PENDING']);

    const cover = await repos.blobs.get(SITE, `relatorio:${idOrigem}`);
    expect(cover?.state).toBe('PENDING');
    expect(cover?.sourceUrl).toContain('reportPDF.seam');
  });

  it('registers documents beyond the budget but only queues what the budget allows', async () => {
    // The report must be able to say "known 412, stored 150, pending 262" rather than pretend
    // the rest do not exist.
    const budgeted = new DetailHandler({
      adapter,
      http,
      db,
      queue,
      cases: repos.cases,
      blobs: repos.blobs,
      session: () => Promise.resolve(session),
      renewSession: () => Promise.resolve(session),
      now: () => NOW,
      classify: (subject) => adapter.classify?.(subject as never) ?? null,
      reserveBlobs: () => 1,
    });
    const local = new Pipeline().register(budgeted);

    const searchJob = await seedSearch({ ini: '2024-01-12', fim: '2024-01-12' });
    await pipeline.run(searchJob);
    await queue.complete(searchJob.id);

    // Find a case that actually has an attached document, so the budget bites.
    for (;;) {
      const job = await queue.lease(SITE, 'w', 60_000);
      if (job === null) throw new Error('no detail job produced a document');
      if (job.kind !== 'detail') continue;
      await local.run(job);
      await queue.complete(job.id);
      const idOrigem = (job.payload as { idOrigem: string }).idOrigem;
      const registered = [];
      for await (const blob of repos.blobs.stream({ site: SITE })) {
        if (blob.idOrigem === idOrigem) registered.push(blob);
      }
      if (registered.length > 1) {
        // Counted per case, not globally: earlier iterations of this loop queued jobs too.
        const { rows } = await db.query<{ n: string | number }>(
          `SELECT count(*) AS n FROM juris.job WHERE site=$1 AND kind='blob' AND key LIKE $2`,
          [SITE, `%:${idOrigem}%`],
        );
        const queuedForThisCase = Number(rows[0]?.n ?? 0);
        expect(registered.length).toBe(2);
        expect(queuedForThisCase).toBe(1);
        return;
      }
    }
  });

  it('recovers from a dead session by renewing and re-running its own partition search', async () => {
    const searchJob = await seedSearch({ ini: '2024-01-12', fim: '2024-01-12' });
    await pipeline.run(searchJob);
    await queue.complete(searchJob.id);

    const job = await queue.lease(SITE, 'w', 60_000);
    if (job === null || job.kind !== 'detail') throw new Error('expected a detail job');

    // Invalidate every issued token, exactly as an expired session does.
    fake.inject({ expireSession: true });
    await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    fake.clearFaults();

    const outcome = await pipeline.run(job);
    expect(outcome.kind).toBe('done');
    const idOrigem = (job.payload as { idOrigem: string }).idOrigem;
    expect((await repos.cases.get(SITE, idOrigem))?.state).toBe('DETAILED');
  });

  it('does not duplicate a case when the session is recovered mid-flight', async () => {
    const searchJob = await seedSearch({ ini: '2024-01-12', fim: '2024-01-12' });
    await pipeline.run(searchJob);
    const before = await repos.cases.countByState(SITE);
    await queue.complete(searchJob.id);

    const job = await queue.lease(SITE, 'w', 60_000);
    if (job === null) throw new Error('expected a job');
    fake.inject({ expireSession: true });
    await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    fake.clearFaults();
    await pipeline.run(job);

    const after = await repos.cases.countByState(SITE);
    const total = (states: Record<string, number>): number =>
      Object.values(states).reduce((sum, n) => sum + n, 0);
    expect(total(after)).toBe(total(before));
  });

  it('is idempotent: detailing the same case twice writes nothing the second time', async () => {
    const { job } = await firstDetail();
    const idOrigem = (job.payload as { idOrigem: string }).idOrigem;
    const first = await repos.cases.get(SITE, idOrigem);

    await pipeline.run(job);
    const second = await repos.cases.get(SITE, idOrigem);
    expect(second?.contentHash).toBe(first?.contentHash);
    expect(second?.state).toBe('DETAILED');
  });
});
