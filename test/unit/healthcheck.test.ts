import { describe, expect, it } from 'vitest';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { healthcheckCommand } from '../../src/app/commands/healthcheck.js';
import { startMetricsServer } from '../../src/infra/metrics/server.js';
import { MetricsRegistry } from '../../src/infra/metrics/registry.js';
import { ExitCode } from '../../src/core/domain/types.js';
import type { SqlExecutor } from '../../src/core/ports/sql.js';

const lines = (): { write: (l: string) => void; text: () => string } => {
  const collected: string[] = [];
  return { write: (l) => collected.push(l), text: () => collected.join('\n') };
};

describe('the healthcheck', () => {
  it('passes on a migrated database and says what it saw', async () => {
    const db = await PgliteExecutor.create();
    await migrate(db);
    const out = lines();
    try {
      expect(await healthcheckCommand({ db, write: out.write })).toBe(ExitCode.OK);
      expect(out.text()).toContain('ok');
      expect(out.text()).toMatch(/migration\(s\)/);
    } finally {
      await db.close();
    }
  });

  it('fails on a reachable database with no schema, rather than creating one', async () => {
    const db = await PgliteExecutor.create();
    const out = lines();
    try {
      expect(await healthcheckCommand({ db, write: out.write })).toBe(ExitCode.SANITY_FAILED);
      // Still unmigrated afterwards: a probe must not repair what it measures.
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'juris'`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('fails when the database cannot be reached at all', async () => {
    const broken: SqlExecutor = {
      driver: 'pg',
      target: 'postgres://juris@localhost:5432/juris',
      query: () => Promise.reject(new Error('ECONNREFUSED 127.0.0.1:5432')),
      execScript: () => Promise.resolve(),
      transaction: () => Promise.reject(new Error('unreachable')),
      close: () => Promise.resolve(),
    };
    const out = lines();
    expect(await healthcheckCommand({ db: broken, write: out.write })).toBe(ExitCode.SANITY_FAILED);
    expect(out.text()).toContain('ECONNREFUSED');
  });

  it('probes the metrics endpoint when one is configured', async () => {
    const db = await PgliteExecutor.create();
    await migrate(db);
    const server = await startMetricsServer(new MetricsRegistry());
    const out = lines();
    try {
      expect(await healthcheckCommand({ db, metricsPort: server.port, write: out.write })).toBe(
        ExitCode.OK,
      );
      expect(out.text()).toContain('/healthz answered 200');
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('fails when the metrics endpoint is configured but dead', async () => {
    const db = await PgliteExecutor.create();
    await migrate(db);
    const out = lines();
    try {
      // A port nothing is listening on: the container is up, the process inside it is not.
      expect(await healthcheckCommand({ db, metricsPort: 1, write: out.write })).toBe(
        ExitCode.SANITY_FAILED,
      );
      expect(out.text()).toContain('FAIL metrics');
    } finally {
      await db.close();
    }
  });
});
