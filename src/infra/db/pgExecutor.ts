/**
 * `SqlExecutor` over a real Postgres server through `pg.Pool`.
 *
 * This is the default path: the one that runs under `docker compose`, the one CI exercises with
 * a service container, and the only one where `SELECT … FOR UPDATE SKIP LOCKED` is doing real
 * work across processes.
 *
 * Invariant: `transaction` pins one connection for the whole callback. Handing out the pool
 * instead would let `BEGIN` and `COMMIT` land on different sockets, which is the kind of bug
 * that only shows up under concurrency.
 */
import pg from 'pg';
import type {
  SqlDriver,
  SqlExecutor,
  SqlResult,
  SqlRow,
  SqlSession,
} from '../../core/ports/sql.js';

const { Pool, types } = pg;

/**
 * Postgres `date` (OID 1082) arrives as a `Date` by default, which drags the local timezone
 * into a value that has none — a `2024-05-15` read in UTC-3 becomes the 14th. Every date in
 * this domain is a partition boundary, so it stays a plain `YYYY-MM-DD` string and the domain
 * layer decides what it means. PGlite already behaves this way, so this also removes a
 * difference between the two drivers.
 */
types.setTypeParser(1082, (value: string) => value);

/**
 * `int8`/`bigint` (OID 20) arrives as a string so that values above 2^53 survive. Job ids are
 * `bigserial`; they are handled as strings end to end rather than silently losing precision.
 */
types.setTypeParser(20, (value: string) => value);

export interface PgExecutorOptions {
  connectionString: string;
  /** Upper bound on pooled connections. One worker never needs many; the queue does the waiting. */
  max?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
}

/** Strips the password from a connection string so it can be logged. */
export function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<unparseable connection string>';
  }
}

class PgSession implements SqlSession {
  constructor(private readonly client: pg.ClientBase) {}

  async query<T extends SqlRow = SqlRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<T>> {
    const res = await this.client.query<T>(text, params as unknown[]);
    return { rows: res.rows, rowCount: res.rowCount };
  }

  async execScript(sql: string): Promise<void> {
    // No parameters means `pg` uses the simple query protocol, which accepts a whole file.
    await this.client.query(sql);
  }
}

export class PgExecutor implements SqlExecutor {
  readonly driver: SqlDriver = 'pg';
  readonly target: string;
  private readonly pool: pg.Pool;

  constructor(options: PgExecutorOptions) {
    this.target = redactConnectionString(options.connectionString);
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
      ...(options.statementTimeoutMillis !== undefined
        ? { statement_timeout: options.statementTimeoutMillis }
        : {}),
    });
    // A pool that emits an unhandled 'error' takes the process down. Idle-client errors are a
    // normal consequence of a server restart; the next acquire will reconnect.
    this.pool.on('error', () => undefined);
  }

  async query<T extends SqlRow = SqlRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<T>> {
    const res = await this.pool.query<T>(text, params as unknown[]);
    return { rows: res.rows, rowCount: res.rowCount };
  }

  async execScript(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: SqlSession) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgSession(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already broken; releasing it with an error discards it from the pool.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
