/**
 * Runs the executor contract against every driver available in this environment.
 *
 * PGlite always runs — that is the point of it. `pg` runs when `TEST_DATABASE_URL` points at a
 * reachable server (docker compose locally, a service container in CI) and is skipped with a
 * visible notice otherwise, so a green run never quietly means "only half the drivers".
 */
import { describe, it } from 'vitest';
import { PgExecutor } from '../../src/infra/db/pgExecutor.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { probePostgres } from '../../src/infra/db/factory.js';
import { runSqlExecutorContract } from './sqlExecutor.contract.js';

runSqlExecutorContract({
  name: 'pglite (in-memory)',
  create: () => PgliteExecutor.create(),
});

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const reachable =
  TEST_DATABASE_URL !== undefined && (await probePostgres(TEST_DATABASE_URL)) === null;

if (reachable && TEST_DATABASE_URL !== undefined) {
  runSqlExecutorContract({
    name: 'pg (server)',
    create: () => Promise.resolve(new PgExecutor({ connectionString: TEST_DATABASE_URL })),
  });
} else {
  describe('SqlExecutor contract: pg (server)', () => {
    it.skip(`skipped: ${
      TEST_DATABASE_URL === undefined
        ? 'TEST_DATABASE_URL is not set'
        : 'TEST_DATABASE_URL is set but the server did not answer'
    } — run "npm run up:infra" to exercise this driver`, () => undefined);
  });
}
