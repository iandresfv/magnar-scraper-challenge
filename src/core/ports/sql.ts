/**
 * The only way the rest of the system talks to Postgres.
 *
 * Responsibility: expose parameterised SQL and transactions, and nothing else. There is no
 * query builder and no ORM here on purpose — nine tables do not justify hiding the SQL, and the
 * SQL is part of what this project is meant to show.
 *
 * Invariant that makes the two drivers interchangeable: every statement written against this
 * port uses `$1, $2` placeholders and standard types. Nothing driver-specific (`pg`'s
 * `Cursor`, PGlite's template tag) leaks past this file, which is what lets one contract suite
 * run against both and lets `DB_DRIVER=pglite` be a real fallback rather than a second backend.
 */

/** A row as returned by the driver: column name to value, already mapped to JS types. */
export type SqlRow = Record<string, unknown>;

export interface SqlResult<T extends SqlRow = SqlRow> {
  rows: T[];
  /** Rows affected by INSERT/UPDATE/DELETE. `null` when the driver does not report it. */
  rowCount: number | null;
}

/**
 * The handle given to a transaction callback. It is deliberately the same shape as the
 * executor minus `transaction`, so repository code can be written once and run either inside
 * or outside a transaction.
 */
export interface SqlSession {
  query<T extends SqlRow = SqlRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<T>>;

  /**
   * Runs a script of several statements separated by `;`, with no parameters.
   *
   * This exists because the two drivers genuinely differ: `pg` falls back to the simple query
   * protocol when a statement carries no parameters and happily runs a whole file, while PGlite
   * always uses the extended protocol and rejects multi-statement text outright. Migrations are
   * the only caller. Everything else uses `query` with `$1` placeholders — passing user input
   * through here would be an injection waiting to happen, and there is no parameter list to
   * make that safe.
   */
  execScript(sql: string): Promise<void>;
}

export interface SqlExecutor extends SqlSession {
  /**
   * Runs `fn` inside a single transaction on a single connection. Commits when `fn` resolves,
   * rolls back when it throws, and rethrows. Nesting is not supported: a repository that needs
   * to compose takes an `SqlSession` and lets the caller own the transaction.
   */
  transaction<T>(fn: (tx: SqlSession) => Promise<T>): Promise<T>;

  /** Which driver is actually running. Reported at startup and stamped into `crawl_run`. */
  readonly driver: SqlDriver;

  /** Human-readable target, safe to log: credentials are stripped. */
  readonly target: string;

  close(): Promise<void>;
}

export type SqlDriver = 'pg' | 'pglite';
