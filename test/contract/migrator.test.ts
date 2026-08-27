import { describe, it } from 'vitest';
import { PgExecutor } from '../../src/infra/db/pgExecutor.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { probePostgres } from '../../src/infra/db/factory.js';
import { runMigratorContract } from './migrator.contract.js';

runMigratorContract({
  name: 'pglite (in-memory)',
  create: () => PgliteExecutor.create(),
});

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const reachable =
  TEST_DATABASE_URL !== undefined && (await probePostgres(TEST_DATABASE_URL)) === null;

if (reachable && TEST_DATABASE_URL !== undefined) {
  runMigratorContract({
    name: 'pg (server)',
    create: () => Promise.resolve(new PgExecutor({ connectionString: TEST_DATABASE_URL })),
  });
} else {
  describe('migrations: pg (server)', () => {
    it.skip('skipped: no reachable TEST_DATABASE_URL', () => undefined);
  });
}
