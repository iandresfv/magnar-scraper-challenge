/**
 * The report, generated from a real crawl.
 *
 * The point of these assertions is not that four files appear — it is that what they say matches
 * what the database holds. A coverage report that is written from the same run it describes is
 * only evidence if it cannot quietly disagree with it, so every number checked here is checked
 * against the tables rather than against a fixture of the report's own output.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { createRepos } from '../../src/infra/db/repos/index.js';
import { PgJobQueue } from '../../src/infra/db/pgJobQueue.js';
import { FetchHttpClient } from '../../src/infra/http/fetchHttpClient.js';
import { crawlCommand } from '../../src/app/commands/crawl.js';
import { reportCommand, type CoverageJson } from '../../src/app/commands/report.js';
import { resolveConfig } from '../../src/app/config.js';
import { createSite } from '../../src/app/registry.js';
import { ExitCode } from '../../src/core/domain/types.js';
import { startFakePje, type FakePjeServer } from '../fake-pje-server/server.js';

const SITE = 'fake-pje';
const ROOT = { ini: '2024-01-01', fim: '2024-01-08' };
const E2E_TIMEOUT = 180_000;

let fake: FakePjeServer;
let db: SqlExecutor;
let outDir: string;
let runId: string;

beforeAll(async () => {
  fake = await startFakePje({ days: 20, seed: 23 });
  db = await PgliteExecutor.create();
  await migrate(db);

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
  runId = result.runId;

  outDir = await mkdtemp(join(tmpdir(), 'juris-report-'));
}, E2E_TIMEOUT);

afterAll(async () => {
  await db.close();
  await fake.close();
});

const run = async (overrides: Partial<Parameters<typeof reportCommand>[0]> = {}): Promise<number> =>
  reportCommand({
    db,
    repos: createRepos(db),
    site: SITE,
    outDir,
    write: () => undefined,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    ...overrides,
  });

const readCoverage = async (): Promise<CoverageJson> =>
  JSON.parse(await readFile(join(outDir, 'coverage.json'), 'utf8')) as CoverageJson;

describe('the report', { timeout: E2E_TIMEOUT }, () => {
  it('writes the four files and exits 0 on a healthy run', async () => {
    expect(await run()).toBe(ExitCode.OK);
    for (const file of ['coverage.md', 'coverage.json', 'metrics.json', 'sample.md']) {
      expect((await readFile(join(outDir, file), 'utf8')).length).toBeGreaterThan(100);
    }
  });

  it('reports the same run, root and tiling the database holds', async () => {
    await run();
    const coverage = await readCoverage();
    const stored = await createRepos(db).runs.get(runId);

    expect(coverage.runId).toBe(runId);
    expect(coverage.root).toEqual(stored?.root);
    expect(coverage.generatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(coverage.tiling.ok).toBe(true);
    expect(coverage.tiling.coveredDays).toBe(coverage.tiling.rootDays);
  });

  it('counts the cases the tables count', async () => {
    await run();
    const coverage = await readCoverage();
    const { rows } = await db.query<{ estado: string; n: string }>(
      `SELECT estado, count(*)::text AS n FROM juris.case_record WHERE site = $1 GROUP BY estado`,
      [SITE],
    );
    for (const row of rows) expect(coverage.cases[row.estado]).toBe(Number(row.n));
    expect(Object.values(coverage.cases).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('adds up the months to the whole run', async () => {
    await run();
    const coverage = await readCoverage();
    const listed = (coverage.cases['LISTED'] ?? 0) + (coverage.cases['DETAILED'] ?? 0);
    expect(coverage.byMonth.reduce((sum, m) => sum + m.cases, 0)).toBe(listed);
  });

  it('renders markdown a human can read, with the numbers in it', async () => {
    await run();
    const markdown = await readFile(join(outDir, 'coverage.md'), 'utf8');
    const coverage = await readCoverage();

    expect(markdown).toContain('# Reporte de cobertura');
    expect(markdown).toContain(runId);
    expect(markdown).toContain(coverage.tiling.ok ? 'sin huecos ni solapes' : 'ROTO');
    expect(markdown).toContain('## Comprobaciones de sanidad');
    // Every sanity check has a row: a report that hides a check is worse than no report.
    for (const check of coverage.checks) expect(markdown).toContain(`| ${check.id} |`);
    // Tables need their blank line, or none of the above renders as a table at all.
    expect(markdown).toContain('\n\n|---|---|\n'.slice(1));
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown).not.toContain('\n\n\n');
  });

  it('masks personal identifiers by default', async () => {
    await run();
    const sample = await readFile(join(outDir, 'sample.md'), 'utf8');
    expect(sample).toContain('Anonimizado');
    expect(sample).toContain('CNPJ ***');
    expect(sample).not.toMatch(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
  });

  it('leaves them intact only when explicitly asked, and says so loudly', async () => {
    await run({ anonymize: false });
    const sample = await readFile(join(outDir, 'sample.md'), 'utf8');
    expect(sample).toMatch(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
    expect(sample).toContain('no publicar este archivo');
  });

  it('renders as many cases as asked for', async () => {
    await run({ sampleSize: 3 });
    const sample = await readFile(join(outDir, 'sample.md'), 'utf8');
    expect(sample.split('\n').filter((line) => line.startsWith('## '))).toHaveLength(3);
    expect(sample).toContain('**Movimientos**');
  });

  it('exports the metrics the run recorded, with their labels parsed', async () => {
    await run();
    const metrics = JSON.parse(await readFile(join(outDir, 'metrics.json'), 'utf8')) as {
      runId: string;
      samples: { name: string; labels: Record<string, string>; value: number }[];
    };
    expect(metrics.runId).toBe(runId);
    expect(metrics.samples.length).toBeGreaterThan(0);
    const jobs = metrics.samples.find((s) => s.name.endsWith('_jobs_total'));
    expect(jobs?.labels).toBeTypeOf('object');
    expect(Number.isFinite(jobs?.value)).toBe(true);
  });

  it('exits 4 when a sanity check fails, so a pipeline cannot publish a broken report', async () => {
    await db.query(
      `UPDATE juris.case_record SET numero = 'not-a-case-number'
       WHERE id_origem = (SELECT id_origem FROM juris.case_record LIMIT 1)`,
    );
    try {
      expect(await run()).toBe(ExitCode.SANITY_FAILED);
      const coverage = await readCoverage();
      expect(coverage.checks.find((c) => c.id === 'S-4')?.ok).toBe(false);
      // ...and the failure is visible in the markdown, not only in the exit code.
      expect(await readFile(join(outDir, 'coverage.md'), 'utf8')).toContain('❌');
    } finally {
      await db.query(
        `UPDATE juris.case_record SET numero = $1 WHERE numero = 'not-a-case-number'`,
        ['0000001-01.2024.4.05.9999'],
      );
    }
  });

  it('says so plainly when there is no run to report on', async () => {
    const lines: string[] = [];
    const code = await run({ site: 'no-such-site', write: (l) => lines.push(l) });
    expect(code).toBe(ExitCode.SANITY_FAILED);
    expect(lines.join('\n')).toContain('no run to report on');
  });
});
