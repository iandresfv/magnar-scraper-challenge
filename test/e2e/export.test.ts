/**
 * The export, over a real crawl.
 *
 * Two claims are worth testing and neither is "a file appeared": that the CSV survives contact
 * with a spreadsheet parser (so the escaping is checked by parsing it back, not by eyeballing the
 * string), and that the JSONL parses line by line — the property that makes it streamable.
 */
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
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
import { ENTITIES, exportCommand } from '../../src/app/commands/export.js';
import { resolveConfig } from '../../src/app/config.js';
import { createSite } from '../../src/app/registry.js';
import { ExitCode } from '../../src/core/domain/types.js';
import { startFakePje, type FakePjeServer } from '../fake-pje-server/server.js';
import { parseCsv } from '../support/csv.js';

const SITE = 'fake-pje';
const E2E_TIMEOUT = 180_000;

let fake: FakePjeServer;
let db: SqlExecutor;
let outDir: string;

beforeAll(async () => {
  fake = await startFakePje({ days: 20, seed: 31 });
  db = await PgliteExecutor.create();
  await migrate(db);
  await crawlCommand({
    config: resolveConfig({
      argv: [
        'crawl',
        '--site',
        SITE,
        '--root-start',
        '2024-01-01',
        '--root-end',
        '2024-01-06',
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
  outDir = await mkdtemp(join(tmpdir(), 'juris-export-'));
}, E2E_TIMEOUT);

afterAll(async () => {
  await db.close();
  await fake.close();
});

const run = async (overrides: Partial<Parameters<typeof exportCommand>[0]> = {}) =>
  exportCommand({ db, site: SITE, format: 'jsonl', outDir, write: () => undefined, ...overrides });

describe('jsonl', { timeout: E2E_TIMEOUT }, () => {
  it('writes one file per entity', async () => {
    const result = await run();
    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.files.map((f) => f.name)).toEqual(ENTITIES.map((e) => e.name));
    expect(result.files.find((f) => f.name === 'case')?.rows).toBeGreaterThan(0);
  });

  it('parses line by line, which is the whole point of the format', async () => {
    const result = await run();
    const text = await readFile(join(outDir, 'case.jsonl'), 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');

    expect(lines).toHaveLength(result.files.find((f) => f.name === 'case')?.rows ?? -1);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(text.endsWith('\n')).toBe(true);
  });

  it('names the fields as the domain does, with dates as ISO strings', async () => {
    await run();
    const first = JSON.parse(
      (await readFile(join(outDir, 'case.jsonl'), 'utf8')).split('\n')[0] ?? '{}',
    ) as Record<string, unknown>;

    expect(first['idOrigem']).toBeTypeOf('string');
    expect(first['dataAutuacaoIni']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first['listedAt']).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Object.keys(first)).not.toContain('id_origem');
    // jsonb stays an object rather than a string of an object.
    expect(first['extra']).toBeTypeOf('object');
  });

  it('exports the same row count the tables hold', async () => {
    const result = await run();
    for (const entity of ENTITIES) {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM juris.${entity.table} WHERE site = $1`,
        [SITE],
      );
      expect(result.files.find((f) => f.name === entity.name)?.rows, entity.name).toBe(
        Number(rows[0]?.n),
      );
    }
  });

  it('pages through the data without losing or repeating a row', async () => {
    // A batch size that does not divide the row count is where an off-by-one lives.
    const small = await run({ batchSize: 7 });
    const big = await run({ batchSize: 10_000 });
    expect(small.files).toEqual(big.files);

    const ids = (await readFile(join(outDir, 'case.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => (JSON.parse(l) as { idOrigem: string }).idOrigem);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('csv', { timeout: E2E_TIMEOUT }, () => {
  it('round-trips through a spreadsheet parser', async () => {
    const result = await run({ format: 'csv' });
    const text = await readFile(join(outDir, 'case.csv'), 'utf8');
    const table = parseCsv(text);

    expect(table.header).toContain('id_origem');
    expect(table.rows).toHaveLength(result.files.find((f) => f.name === 'case')?.rows ?? -1);
    for (const row of table.rows) expect(row).toHaveLength(table.header.length);
  });

  it('keeps a comma, a quote and a newline inside one field', async () => {
    // Court text contains all three; a naive join loses the row boundary on the first one.
    await db.query(
      `UPDATE juris.case_record SET classe = $1 WHERE id_origem = (
         SELECT id_origem FROM juris.case_record WHERE site = $2 ORDER BY id_origem LIMIT 1)`,
      ['APELAÇÃO, "CÍVEL"\ne mais', SITE],
    );
    try {
      await run({ format: 'csv' });
      const table = parseCsv(await readFile(join(outDir, 'case.csv'), 'utf8'));
      const column = table.header.indexOf('classe');
      expect(table.rows.map((r) => r[column])).toContain('APELAÇÃO, "CÍVEL"\ne mais');
      for (const row of table.rows) expect(row).toHaveLength(table.header.length);
    } finally {
      await db.query(
        `UPDATE juris.case_record SET classe = 'APELAÇÃO CÍVEL' WHERE classe LIKE $1`,
        ['APELAÇÃO, %'],
      );
    }
  });

  it('starts with a BOM, so a spreadsheet does not render the accents as mojibake', async () => {
    await run({ format: 'csv' });
    const text = await readFile(join(outDir, 'case.csv'), 'utf8');
    expect(text.codePointAt(0)).toBe(0xfeff);
    expect(text).toContain('\r\n');
  });

  it('writes a header even when the table is empty', async () => {
    await db.query(`DELETE FROM juris.blob WHERE site = $1`, [SITE]);
    const result = await run({ format: 'csv', only: ['blob'] });
    const text = await readFile(join(outDir, 'blob.csv'), 'utf8');

    expect(result.files[0]?.rows).toBe(0);
    expect(text.replace('\uFEFF', '').trim().split(',')).toContain('storage_uri');
  });
});

describe('the options', { timeout: E2E_TIMEOUT }, () => {
  it('exports only what was asked for', async () => {
    const result = await run({ only: ['case', 'movement'] });
    expect(result.files.map((f) => f.name)).toEqual(['case', 'movement']);
  });

  it('says so rather than writing nothing silently when the name is wrong', async () => {
    const lines: string[] = [];
    const result = await run({ only: ['cases'], write: (l) => lines.push(l) });
    expect(result.exitCode).toBe(ExitCode.SANITY_FAILED);
    expect(lines.join('\n')).toContain('known entities');
  });

  it('masks identifiers on request and leaves them alone by default', async () => {
    await run({ only: ['party'], anonymize: true });
    const masked = await readFile(join(outDir, 'party.jsonl'), 'utf8');
    expect(masked).toContain('"docDigitos":"***');
    expect(masked).not.toContain('08409021000177');

    await run({ only: ['party'] });
    expect(await readFile(join(outDir, 'party.jsonl'), 'utf8')).toContain('08409021000177');
  });
});
