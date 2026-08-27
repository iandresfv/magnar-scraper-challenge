/**
 * Chooses a database driver, with the automatic fallback that keeps `npm start` working on a
 * machine without Docker.
 *
 * The rule, in order:
 *   1. `DB_DRIVER` set explicitly wins. No probing, no surprises in CI.
 *   2. Otherwise, if `DATABASE_URL` is set, probe it with a short timeout. If it answers, use
 *      `pg`.
 *   3. Otherwise fall back to PGlite and say so in **one line**. Falling back silently would be
 *      worse than failing: someone would run a crawl against an embedded database believing it
 *      went to the server.
 */
import type { SqlExecutor } from '../../core/ports/sql.js';
import { PgExecutor, redactConnectionString } from './pgExecutor.js';
import { PgliteExecutor } from './pgliteExecutor.js';

export interface DbConfig {
  driver?: 'pg' | 'pglite' | undefined;
  databaseUrl?: string | undefined;
  dbPath?: string | undefined;
  probeTimeoutMs?: number;
}

export interface DbSelection {
  executor: SqlExecutor;
  /** Set when the selection was not the one the configuration asked for. Worth logging once. */
  fallbackNotice: string | null;
}

/** Opens a connection and closes it. Returns the reason it failed, or `null` on success. */
export async function probePostgres(url: string, timeoutMs = 3_000): Promise<string | null> {
  const executor = new PgExecutor({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
  });
  try {
    await executor.query('SELECT 1');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await executor.close().catch(() => undefined);
  }
}

export async function createSqlExecutor(config: DbConfig): Promise<DbSelection> {
  const { driver, databaseUrl, dbPath, probeTimeoutMs = 3_000 } = config;

  if (driver === 'pg') {
    if (databaseUrl === undefined || databaseUrl === '') {
      throw new Error('DB_DRIVER=pg requires DATABASE_URL to be set.');
    }
    return { executor: new PgExecutor({ connectionString: databaseUrl }), fallbackNotice: null };
  }

  if (driver === 'pglite') {
    return {
      executor: await PgliteExecutor.create(dbPath !== undefined ? { dataDir: dbPath } : {}),
      fallbackNotice: null,
    };
  }

  if (databaseUrl !== undefined && databaseUrl !== '') {
    const failure = await probePostgres(databaseUrl, probeTimeoutMs);
    if (failure === null) {
      return { executor: new PgExecutor({ connectionString: databaseUrl }), fallbackNotice: null };
    }
    return {
      executor: await PgliteExecutor.create(dbPath !== undefined ? { dataDir: dbPath } : {}),
      fallbackNotice:
        `Postgres at ${redactConnectionString(databaseUrl)} did not answer (${failure}); ` +
        `using the embedded PGlite database at ${dbPath ?? 'memory://'}. ` +
        `Run "npm run up:infra" for the Docker path, or set DB_DRIVER=pglite to silence this.`,
    };
  }

  return {
    executor: await PgliteExecutor.create(dbPath !== undefined ? { dataDir: dbPath } : {}),
    fallbackNotice: `No DATABASE_URL configured; using the embedded PGlite database at ${dbPath ?? 'memory://'}.`,
  };
}
