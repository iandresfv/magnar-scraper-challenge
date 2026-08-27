/**
 * A dedicated Postgres database per contract suite.
 *
 * Vitest runs test files in parallel. Every suite that exercises the real driver wants to start
 * from a clean schema, so they all ran `DROP SCHEMA juris CASCADE` — against the same database,
 * at the same time. The result was not a flake but a reliable failure: one suite dropped the
 * tables another was midway through using.
 *
 * Sharing a server while owning a database is the right granularity. It also removes the
 * `CREATE EXTENSION` race for free, since an extension is per-database and each suite now
 * installs its own with nobody else looking.
 */
import { PgExecutor } from '../../src/infra/db/pgExecutor.js';
import { probePostgres } from '../../src/infra/db/factory.js';

export interface TestDatabase {
  url: string;
  drop: () => Promise<void>;
}

/**
 * Creates (or recreates) `juris_test_<name>` on the server `TEST_DATABASE_URL` points at.
 * Returns `null` when there is no reachable server, which is how the no-Docker path stays green.
 */
export async function acquireTestDatabase(name: string): Promise<TestDatabase | null> {
  const base = process.env['TEST_DATABASE_URL'];
  if (base === undefined || base === '') return null;
  if ((await probePostgres(base)) !== null) return null;

  const dbName = `juris_test_${name.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
  const admin = new PgExecutor({ connectionString: base, max: 1 });
  try {
    // CREATE/DROP DATABASE cannot run inside a transaction, so these go through `query`
    // directly. Terminating stale backends first stops a leftover connection from a killed
    // run holding the database hostage.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.close();
  }

  const url = new URL(base);
  url.pathname = `/${dbName}`;
  const dbUrl = url.toString();

  const target = new PgExecutor({ connectionString: dbUrl, max: 1 });
  try {
    await target.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
  } finally {
    await target.close();
  }

  return {
    url: dbUrl,
    drop: async () => {
      const cleaner = new PgExecutor({ connectionString: base, max: 1 });
      try {
        await cleaner.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        await cleaner.query(`DROP DATABASE IF EXISTS ${dbName}`);
      } catch {
        // A leftover test database is untidy, not a failure worth failing a green run over.
      } finally {
        await cleaner.close();
      }
    },
  };
}
