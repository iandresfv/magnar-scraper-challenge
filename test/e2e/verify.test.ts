/**
 * The sanity checks, against real crawled data.
 *
 * The interesting assertions are the negative ones: a checker that only ever sees good data is
 * indistinguishable from `return ok`. So each error-severity check is also shown failing, by
 * corrupting exactly the thing it is meant to notice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { createRepos } from '../../src/infra/db/repos/index.js';
import { PgJobQueue } from '../../src/infra/db/pgJobQueue.js';
import { FetchHttpClient } from '../../src/infra/http/fetchHttpClient.js';
import { crawlCommand } from '../../src/app/commands/crawl.js';
import { verifyCommand } from '../../src/app/commands/verify.js';
import { verifyRun, sampleDrift } from '../../src/core/usecases/verifyRun.js';
import { resolveConfig } from '../../src/app/config.js';
import { createSite } from '../../src/app/registry.js';
import { ExitCode } from '../../src/core/domain/types.js';
import { startFakePje, type FakePjeServer } from '../fake-pje-server/server.js';

const SITE = 'fake-pje';
const ROOT = { ini: '2024-01-01', fim: '2024-01-08' };
const E2E_TIMEOUT = 180_000;

let fake: FakePjeServer;
let db: SqlExecutor;
let runId: string;

beforeAll(async () => {
  fake = await startFakePje({ days: 20, seed: 17 });
  db = await PgliteExecutor.create();
  await migrate(db);
}, E2E_TIMEOUT);

afterAll(async () => {
  await db.close();
  await fake.close();
});

async function crawl(): Promise<string> {
  const result = await crawlCommand({
    config: resolveConfig({
      argv: [
        'crawl',
        '--site',
        SITE,
        '--root-start',
        ROOT.ini,
        '--root-end',
        ROOT.fim,
        '--pdf-budget',
        '0',
      ],
      env: {},
    }),
    adapter: createSite(SITE, { baseUrl: fake.url }),
    http: new FetchHttpClient({ defaultTimeoutMs: 5_000 }),
    db,
    repos: createRepos(db),
    queue: new PgJobQueue(db, { defaultLeaseMs: 30_000 }),
    log: () => undefined,
    progressEveryMs: 1_000_000,
  });
  return result.runId;
}

beforeEach(async () => {
  fake.clearFaults();
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
    'site_throttle',
    'crawl_run',
  ]) {
    await db.query(`DELETE FROM juris.${table}`);
  }
  runId = await crawl();
}, E2E_TIMEOUT);

const report = async (): Promise<Awaited<ReturnType<typeof verifyRun>>> =>
  verifyRun({ db, repos: createRepos(db), site: SITE, runId, root: ROOT });

const check = (r: Awaited<ReturnType<typeof verifyRun>>, id: string) =>
  r.checks.find((c) => c.id === id);

describe('a healthy run', { timeout: E2E_TIMEOUT }, () => {
  it('passes every error-severity check', async () => {
    const result = await report();
    const failed = result.checks.filter((c) => !c.ok && c.severity === 'error');
    expect(failed.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('shows the numbers behind each verdict, not only the verdict', async () => {
    for (const c of (await report()).checks) {
      expect(Object.keys(c.evidence).length, `${c.id} has no evidence`).toBeGreaterThan(0);
      expect(c.detail.length).toBeGreaterThan(10);
    }
  });

  it('exits 0 through the command', async () => {
    const lines: string[] = [];
    const code = await verifyCommand({
      db,
      repos: createRepos(db),
      site: SITE,
      write: (l) => lines.push(l),
    });
    expect(code).toBe(ExitCode.OK);
    expect(lines.join('\n')).toContain('can be trusted');
  });

  it('reports the designed GAP as the only unexhausted partition', async () => {
    const gap = check(await report(), 'S-2');
    const inRoot = fake.dataset.gapDay >= ROOT.ini && fake.dataset.gapDay <= ROOT.fim;
    expect(gap?.ok).toBe(!inRoot);
    if (inRoot) {
      expect(gap?.detail).toContain('hit the cap');
      expect((gap?.evidence['gaps'] as unknown[]).length).toBeGreaterThan(0);
    }
  });
});

describe('each check can fail', { timeout: E2E_TIMEOUT }, () => {
  it('S-1 notices a hole in the tiling', async () => {
    // Remove a resolved leaf: the days it covered are now covered by nothing.
    await db.query(
      `DELETE FROM juris.partition WHERE id = (
         SELECT id FROM juris.partition
          WHERE status = 'LEAF_DONE' AND facets = '{}'::jsonb
          ORDER BY data_ini OFFSET 1 LIMIT 1)`,
    );
    const tiling = check(await report(), 'S-1');
    expect(tiling?.ok).toBe(false);
    expect(tiling?.detail).toMatch(/gap|missing/);
  });

  it('S-4 notices a malformed case number', async () => {
    await db.query(
      `UPDATE juris.case_record SET numero = 'not-a-case-number'
       WHERE id_origem = (SELECT id_origem FROM juris.case_record LIMIT 1)`,
    );
    const numbers = check(await report(), 'S-4');
    expect(numbers?.ok).toBe(false);
    expect(numbers?.detail).toContain('not-a-case-number');
  });

  it('S-6 notices mojibake in stored text', async () => {
    // The corruption this whole project is arranged to prevent, injected directly.
    const damaged = Buffer.from('APELAÇÃO CÍVEL', 'utf8').toString('latin1');
    await db.query(
      `UPDATE juris.case_record SET classe = $1
       WHERE id_origem = (SELECT id_origem FROM juris.case_record LIMIT 1)`,
      [damaged],
    );
    const encoding = check(await report(), 'S-6');
    expect(encoding?.ok).toBe(false);
    expect(encoding?.evidence['corrupted']).toBe(1);
  });

  it('S-10 notices a stored document with no hash', async () => {
    await db.query(
      `INSERT INTO juris.blob (site, key, id_origem, tipo, source_url, storage_uri, estado, bytes)
       SELECT site, 'relatorio:broken', id_origem, 'relatorio', 'https://x', 'file:///x', 'STORED', 10
       FROM juris.case_record LIMIT 1`,
    );
    const documents = check(await report(), 'S-10');
    expect(documents?.ok).toBe(false);
    expect(documents?.evidence['broken']).toBe(1);
  });

  it('S-11 warns about abandoned jobs without failing the run', async () => {
    await db.query(
      `INSERT INTO juris.job (site, kind, key, payload, status, failure_class)
       VALUES ($1, 'blob', 'blob:dead', '{}', 'dead', 'NOT_PDF')`,
      [SITE],
    );
    const result = await report();
    const dlq = check(result, 'S-11');
    expect(dlq?.ok).toBe(false);
    expect(dlq?.severity).toBe('warn');
    // A warning must not, on its own, condemn the run.
    expect(result.ok).toBe(true);
  });

  it('the command exits 4 when an error check fails', async () => {
    // One row only: `(site, numero)` is unique, so setting them all to the same value would be
    // rejected by the schema before the check ever ran.
    await db.query(
      `UPDATE juris.case_record SET numero = 'broken'
       WHERE id_origem = (SELECT id_origem FROM juris.case_record LIMIT 1)`,
    );
    const lines: string[] = [];
    const code = await verifyCommand({
      db,
      repos: createRepos(db),
      site: SITE,
      write: (l) => lines.push(l),
    });
    expect(code).toBe(ExitCode.SANITY_FAILED);
    expect(lines.join('\n')).toContain('should NOT be trusted');
  });

  it('says so plainly when there is nothing to verify', async () => {
    // Partitions reference the run, so they go first — the foreign key is doing its job.
    await db.query('DELETE FROM juris.partition');
    await db.query('DELETE FROM juris.crawl_run');
    const lines: string[] = [];
    const code = await verifyCommand({
      db,
      repos: createRepos(db),
      site: SITE,
      write: (l) => lines.push(l),
    });
    expect(code).toBe(ExitCode.SANITY_FAILED);
    expect(lines.join('\n')).toContain('no run to verify');
  });
});

describe('drift sampling', { timeout: E2E_TIMEOUT }, () => {
  it('re-queries leaves and finds them unchanged', async () => {
    const adapter = createSite(SITE, { baseUrl: fake.url });
    const http = new FetchHttpClient({ defaultTimeoutMs: 5_000 });
    const session = await adapter.bootstrap(http);

    const result = await sampleDrift({
      repos: createRepos(db),
      runId,
      sampleSize: 5,
      search: async (range, facets) =>
        (await adapter.search(http, session, { range, facets })).rows.length,
      random: () => 0,
    });

    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.drifted).toBe(0);
    for (const sample of result.samples) {
      expect(sample.observedRows).toBe(sample.storedRows);
    }
  });

  it('notices when a leaf has changed since the crawl', async () => {
    // Pretend the crawl saw a different number: exactly what site drift looks like afterwards.
    await db.query(
      `UPDATE juris.partition SET observed_rows = observed_rows * 3
       WHERE status = 'LEAF_DONE' AND observed_rows > 0`,
    );
    const adapter = createSite(SITE, { baseUrl: fake.url });
    const http = new FetchHttpClient({ defaultTimeoutMs: 5_000 });
    const session = await adapter.bootstrap(http);

    const result = await sampleDrift({
      repos: createRepos(db),
      runId,
      sampleSize: 3,
      search: async (range, facets) =>
        (await adapter.search(http, session, { range, facets })).rows.length,
      random: () => 0,
    });
    expect(result.drifted).toBeGreaterThan(0);
  });

  it('touches no network when the sample size is zero', async () => {
    const before = fake.counts['search'] ?? 0;
    await verifyCommand({
      db,
      repos: createRepos(db),
      site: SITE,
      sample: 0,
      write: () => undefined,
    });
    expect(fake.counts['search']).toBe(before);
  });
});
