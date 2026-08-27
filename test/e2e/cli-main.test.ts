/**
 * The entry point, driven the way a person drives it.
 *
 * Every other test calls the command functions directly, which is exactly how `main` shipped a
 * process that produced no output and exited 13: a bare `return commandPromise` inside a
 * `try/finally` runs the `finally` — closing the database — before adopting the promise, so the
 * command could never complete. Only a test that goes through `main` can see that.
 *
 * So these assertions are deliberately shallow and deliberately complete: every command, through
 * the real entry point, must settle and return a number.
 */
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/app/main.js';
import { ExitCode } from '../../src/core/domain/types.js';

const TIMEOUT = 60_000;
let dbPath: string;
let outDir: string;
const saved = { ...process.env };

beforeAll(async () => {
  dbPath = await mkdtemp(join(tmpdir(), 'juris-cli-db-'));
  outDir = await mkdtemp(join(tmpdir(), 'juris-cli-out-'));
  // The no-Docker path, so the suite needs nothing running. Same code, same SQL.
  process.env['DB_DRIVER'] = 'pglite';
  process.env['DB_PATH'] = dbPath;
  delete process.env['DATABASE_URL'];
}, TIMEOUT);

afterAll(() => {
  process.env = saved;
});

/** Each call opens and closes its own executor, which is the point: it has to survive that. */
const run = (...argv: string[]): Promise<number> => main(argv);

describe('every command settles when run through main', { timeout: TIMEOUT }, () => {
  it('prints usage and the version without touching a database', async () => {
    expect(await run()).toBe(ExitCode.OK);
    expect(await run('version')).toBe(ExitCode.OK);
  });

  it('verifies, and says there is nothing to verify rather than hanging', async () => {
    // Also the call that migrates: `DB_AUTO_MIGRATE` is on, so the schema exists after this.
    expect(await run('verify', '--site', 'br-trf5')).toBe(ExitCode.SANITY_FAILED);
  });

  it('passes its own healthcheck once the schema is there', async () => {
    expect(await run('healthcheck')).toBe(ExitCode.OK);
  });

  it('reports, and says there is nothing to report on', async () => {
    expect(await run('report', '--site', 'br-trf5', '--out', outDir)).toBe(ExitCode.SANITY_FAILED);
  });

  it('exports an empty dataset without complaining', async () => {
    expect(await run('export', '--site', 'br-trf5', '--out', outDir, '--format', 'csv')).toBe(
      ExitCode.OK,
    );
    expect((await readdir(outDir)).filter((f) => f.endsWith('.csv')).length).toBeGreaterThan(0);
  });

  it('lists and retries the dead letter queue', async () => {
    expect(await run('dlq:list', '--site', 'br-trf5')).toBe(ExitCode.OK);
    expect(await run('retry-dlq', '--site', 'br-trf5')).toBe(ExitCode.OK);
  });

  it('rejects an unknown command with a code instead of a stack trace', async () => {
    expect(await run('frobnicate')).toBe(ExitCode.SANITY_FAILED);
  });

  it('rejects an unknown export format before opening anything', async () => {
    expect(await run('export', '--format', 'parquet')).toBe(ExitCode.SANITY_FAILED);
  });
});
