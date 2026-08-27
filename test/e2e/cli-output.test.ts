/**
 * What the operator actually sees.
 *
 * A crawl over a decade of a docket runs for hours in a terminal somebody is watching. These
 * assertions are about that terminal: that it moves, that it says how much is left, and that when
 * it stops it says what happened in a sentence rather than in an integer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { createRepos } from '../../src/infra/db/repos/index.js';
import { PgJobQueue } from '../../src/infra/db/pgJobQueue.js';
import { FetchHttpClient } from '../../src/infra/http/fetchHttpClient.js';
import { crawlCommand } from '../../src/app/commands/crawl.js';
import { resolveConfig } from '../../src/app/config.js';
import { createSite } from '../../src/app/registry.js';
import { ExitCode } from '../../src/core/domain/types.js';
import { startFakePje, type FakePjeServer } from '../fake-pje-server/server.js';

const SITE = 'fake-pje';
const E2E_TIMEOUT = 120_000;

let fake: FakePjeServer;
let db: SqlExecutor;

beforeAll(async () => {
  fake = await startFakePje({ days: 12, seed: 41 });
  db = await PgliteExecutor.create();
  await migrate(db);
}, E2E_TIMEOUT);

afterAll(async () => {
  await db.close();
  await fake.close();
});

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
});

async function crawl(
  extra: string[] = [],
  progressEveryMs = 0,
): Promise<{ lines: string[]; exitCode: number }> {
  const lines: string[] = [];
  const result = await crawlCommand({
    config: resolveConfig({
      argv: [
        'crawl',
        '--site',
        SITE,
        '--root-start',
        '2024-01-01',
        '--root-end',
        '2024-01-05',
        '--pdf-budget',
        '0',
        ...extra,
      ],
      env: {},
    }),
    adapter: createSite(SITE, { baseUrl: fake.url }),
    http: new FetchHttpClient({ defaultTimeoutMs: 5_000 }),
    db,
    repos: createRepos(db),
    queue: new PgJobQueue(db, { defaultLeaseMs: 30_000 }),
    log: (line) => lines.push(line),
    progressEveryMs,
  });
  return { lines, exitCode: result.exitCode };
}

describe('the progress line', { timeout: E2E_TIMEOUT }, () => {
  it('appears while the run is working, with the counts and an eta', async () => {
    // Zero interval: every job prints, which is what the 30 s default does over a long run.
    const { lines } = await crawl([], 0);
    const progress = lines.filter((line) => line.includes(' · eta '));

    expect(progress.length).toBeGreaterThan(1);
    expect(progress[0]).toMatch(/jobs \d+ done · \d+ pending · \d+ dead/);
    expect(progress[0]).toMatch(/cases \d+ \(\d+ detailed\)/);
    expect(progress[0]).toMatch(/eta (~[\dhms ]+|—|done)/);
  });

  it('stays quiet when the interval has not elapsed', async () => {
    const { lines } = await crawl([], 10 * 60 * 1000);
    expect(lines.filter((line) => line.includes(' · eta '))).toEqual([]);
  });
});

describe('the closing summary', { timeout: E2E_TIMEOUT }, () => {
  it('ends with a block that explains the exit code in words', async () => {
    const { lines, exitCode } = await crawl();
    const text = lines.join('\n');

    expect(exitCode).toBe(ExitCode.OK);
    expect(text).toContain('elapsed');
    expect(text).toContain('cases');
    expect(text).toContain('documents');
    expect(text).toContain('exit');
    expect(text).toContain('0 — the run completed and the queue is empty');
    expect(text).toContain('npm run verify');
  });

  it('says the run is paused, and how to resume it, when it stopped early', async () => {
    const { lines } = await crawl(['--max-jobs', '1']);
    const text = lines.join('\n');
    expect(text).toContain('paused');
    expect(text).toMatch(/elapsed\s+\d+[hms]/);
  });
});
