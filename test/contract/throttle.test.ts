import { afterAll, describe, it } from 'vitest';
import { PgExecutor } from '../../src/infra/db/pgExecutor.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { acquireTestDatabase } from '../support/pgDatabase.js';
import { runThrottleContract } from './throttle.contract.js';

// PGlite serialises on one connection, so the control law and the breaker are all meaningful
// there; only the genuine race needs a server.
runThrottleContract({
  name: 'pglite (single connection)',
  create: () => PgliteExecutor.create(),
  concurrent: false,
});

const database = await acquireTestDatabase('throttle');

if (database !== null) {
  runThrottleContract({
    name: 'pg (server)',
    create: () => Promise.resolve(new PgExecutor({ connectionString: database.url, max: 10 })),
    concurrent: true,
  });
  afterAll(async () => {
    await database.drop();
  });
} else {
  describe('shared throttle: pg (server)', () => {
    it.skip('skipped: no reachable TEST_DATABASE_URL — the concurrency property needs a server', () =>
      undefined);
  });
}
