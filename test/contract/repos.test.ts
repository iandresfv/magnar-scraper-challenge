/**
 * Runs the contract against every driver available here.
 *
 * PGlite always runs — that is the point of it. The server driver runs against a database
 * created just for this file (see test/support/pgDatabase.ts), so parallel suites cannot drop
 * each other's schema, and is skipped with a visible notice when no server answers.
 */
import { afterAll, describe, it } from 'vitest';
import { PgExecutor } from '../../src/infra/db/pgExecutor.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { acquireTestDatabase } from '../support/pgDatabase.js';
import { runReposContract } from './repos.contract.js';

runReposContract({ name: 'pglite (in-memory)', create: () => PgliteExecutor.create() });

const database = await acquireTestDatabase('repos');

if (database !== null) {
  runReposContract({
    name: 'pg (server)',
    create: () => Promise.resolve(new PgExecutor({ connectionString: database.url })),
  });
  afterAll(async () => {
    await database.drop();
  });
} else {
  describe('repositories: pg (server)', () => {
    it.skip('skipped: TEST_DATABASE_URL is unset or the server did not answer — run "npm run up:infra"', () =>
      undefined);
  });
}
