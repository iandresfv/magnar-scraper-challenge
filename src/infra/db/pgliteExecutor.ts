/**
 * `SqlExecutor` over PGlite: Postgres itself, compiled to WebAssembly.
 *
 * This is the no-Docker path. It is not a second database with its own dialect — it runs the
 * same DDL, the same `$1` placeholders and the same `EXCLUDE USING gist` constraint as the
 * server, which is the whole reason it was chosen over SQLite. `btree_gist` is loaded
 * explicitly because the partition tiling invariant is expressed as a database constraint and
 * would otherwise fail to apply on this driver only.
 *
 * Known and documented limitation: PGlite is a single connection. `FOR UPDATE SKIP LOCKED` is
 * still correct, but there is no second process to skip past, so the multi-process queue and
 * throttle tests are the ones that require `TEST_DATABASE_URL`. In this mode the `all` role
 * uses in-process concurrency.
 */
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import type {
  SqlDriver,
  SqlExecutor,
  SqlResult,
  SqlRow,
  SqlSession,
} from '../../core/ports/sql.js';

/** `date`: kept as `YYYY-MM-DD`, because a partition boundary has no time and no zone. */
const PG_OID_DATE = 1082;
/** `int8`: kept as a string so `bigserial` job ids survive above 2^53. */
const PG_OID_INT8 = 20;

export interface PgliteExecutorOptions {
  /** Directory to persist into. Omit for an in-memory database (used by most tests). */
  dataDir?: string;
}

interface PgliteQueryTarget {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}

class PgliteSession implements SqlSession {
  constructor(private readonly target: PgliteQueryTarget) {}

  async query<T extends SqlRow = SqlRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<T>> {
    const res = await this.target.query<T>(text, params as unknown[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  async execScript(sql: string): Promise<void> {
    // PGlite always speaks the extended protocol from `query`, which rejects multi-statement
    // text; `exec` is its simple-protocol equivalent.
    await this.target.exec(sql);
  }
}

export class PgliteExecutor implements SqlExecutor {
  readonly driver: SqlDriver = 'pglite';
  readonly target: string;
  private readonly db: PGlite;
  /**
   * PGlite serialises on one connection, so two overlapping `transaction()` calls would
   * interleave their `BEGIN`/`COMMIT`. In-process concurrency is a supported mode here, so
   * transactions queue behind each other instead of corrupting one another.
   */
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(db: PGlite, target: string) {
    this.db = db;
    this.target = target;
  }

  static async create(options: PgliteExecutorOptions = {}): Promise<PgliteExecutor> {
    const db = await PGlite.create({
      ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
      extensions: { btree_gist },
      // Match the `pg` driver exactly. Left alone, PGlite hands back a JS `Date` for `date`,
      // which drags the process timezone into a value that has none: a partition boundary of
      // 2024-05-15 read in UTC-3 becomes the 14th. The contract suite caught this divergence
      // between the two drivers, which is what it exists for.
      parsers: {
        [PG_OID_DATE]: (value: string) => value,
        [PG_OID_INT8]: (value: string) => value,
      },
    });
    return new PgliteExecutor(db, options.dataDir ?? 'memory://');
  }

  async query<T extends SqlRow = SqlRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlResult<T>> {
    const res = await this.db.query<T>(text, params as unknown[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  async execScript(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlSession) => Promise<T>): Promise<T> {
    const run = this.tail.then(() =>
      this.db.transaction(async (tx) => fn(new PgliteSession(tx as PgliteQueryTarget))),
    );
    // Keep the chain alive even when this transaction rejects, so one failure does not wedge
    // every later transaction behind a rejected promise.
    this.tail = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
