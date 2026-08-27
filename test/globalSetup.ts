/**
 * Runs once, before any test file, when a real Postgres is reachable.
 *
 * Why this exists: `CREATE EXTENSION IF NOT EXISTS` is **not** concurrency-safe in Postgres.
 * The `IF NOT EXISTS` check and the catalog insert are not atomic, so two sessions that reach
 * it at the same instant produce
 * `duplicate key value violates unique constraint "pg_extension_name_index"`. Vitest runs test
 * files in parallel and more than one contract suite needs `btree_gist`, so on a *clean*
 * database — CI, every time — the race was not a flake but the normal outcome.
 *
 * Creating the extension once here removes the window entirely. The migration keeps its own
 * `CREATE EXTENSION IF NOT EXISTS`, which is the right statement for a real deployment where a
 * single migration step runs alone.
 */
import { PgExecutor } from '../src/infra/db/pgExecutor.js';
import { probePostgres } from '../src/infra/db/factory.js';

export async function setup(): Promise<void> {
  const url = process.env['TEST_DATABASE_URL'];
  if (url === undefined || url === '') return;
  if ((await probePostgres(url)) !== null) return;

  const db = new PgExecutor({ connectionString: url, max: 1 });
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
  } finally {
    await db.close();
  }
}
