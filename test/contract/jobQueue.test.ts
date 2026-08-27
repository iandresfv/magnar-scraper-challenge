import { afterAll, describe, it } from 'vitest';
import { PgExecutor } from '../../src/infra/db/pgExecutor.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { acquireTestDatabase } from '../support/pgDatabase.js';
import { runJobQueueContract } from './jobQueue.contract.js';

// PGlite is a single connection, so `SKIP LOCKED` has nothing to skip past. Everything except
// the concurrency property is still meaningful there, and is asserted.
runJobQueueContract({
  name: 'pglite (single connection)',
  create: () => PgliteExecutor.create(),
  concurrent: false,
});

const database = await acquireTestDatabase('jobqueue');

if (database !== null) {
  runJobQueueContract({
    name: 'pg (server)',
    create: () => Promise.resolve(new PgExecutor({ connectionString: database.url, max: 8 })),
    concurrent: true,
  });
  afterAll(async () => {
    await database.drop();
  });
} else {
  describe('job queue: pg (server)', () => {
    it.skip('skipped: no reachable TEST_DATABASE_URL — the concurrency property needs a real server', () =>
      undefined);
  });
}
