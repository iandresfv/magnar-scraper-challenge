/**
 * The migration contract, run against both drivers.
 *
 * The interesting assertions are not "the tables exist" but the ones that would let a broken
 * schema through unnoticed: that a second run changes nothing, that the tiling constraint is
 * actually enforced (it is the one piece of DDL that a driver could silently drop), and that
 * editing a shipped migration is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { migrate } from '../../src/infra/db/migrator.js';

export interface MigratorSubject {
  name: string;
  create: () => Promise<SqlExecutor>;
}

/** Every table 001_core.sql is expected to create, plus the runner's own bookkeeping table. */
const EXPECTED_TABLES = [
  'blob',
  'case_record',
  'class_vocabulary',
  'crawl_run',
  'document',
  'job',
  'lawyer',
  'metric',
  'movement',
  'partition',
  'party',
  'schema_migration',
  'site',
  'site_throttle',
  'subject',
];

export function runMigratorContract(subject: MigratorSubject): void {
  describe(`migrations: ${subject.name}`, () => {
    let db: SqlExecutor;

    beforeAll(async () => {
      db = await subject.create();
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE');
      await migrate(db);
    });

    afterAll(async () => {
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE').catch(() => undefined);
      await db.close();
    });

    it('creates every expected table', async () => {
      const { rows } = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'juris' ORDER BY table_name`,
      );
      expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
    });

    it('installs btree_gist', async () => {
      const { rows } = await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`);
      expect(rows).toHaveLength(1);
    });

    it('is idempotent: a second run applies nothing', async () => {
      const second = await migrate(db);
      expect(second.applied).toHaveLength(0);
      expect(second.skipped.length).toBeGreaterThan(0);
    });

    it('records what it applied, with a checksum', async () => {
      const { rows } = await db.query<{ version: string | number; checksum: string }>(
        `SELECT version, checksum FROM juris.schema_migration ORDER BY version`,
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.version)).toBe(1);
      expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuses to run when a shipped migration was edited', async () => {
      await db.query(`UPDATE juris.schema_migration SET checksum = 'tampered' WHERE version = 1`);
      await expect(migrate(db)).rejects.toThrow(/changed after it was applied/);
      // Leave the table as the real run found it, so later assertions still hold.
      const { rows } = await db.query<{ checksum: string }>(
        `SELECT checksum FROM juris.schema_migration WHERE version = 1`,
      );
      expect(rows[0]?.checksum).toBe('tampered');
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE');
      await migrate(db);
    });

    it('enforces the partition tiling constraint against overlapping primary leaves', async () => {
      await seedSiteAndRun(db);
      await db.query(
        `INSERT INTO juris.partition (site, id, run_id, data_ini, data_fim, status)
         VALUES ('t', 'a', $1, '2024-01-01', '2024-01-31', 'LEAF_DONE')`,
        [RUN_ID],
      );
      // Overlapping, same site, both resolved primary leaves: the database must refuse.
      await expect(
        db.query(
          `INSERT INTO juris.partition (site, id, run_id, data_ini, data_fim, status)
           VALUES ('t', 'b', $1, '2024-01-15', '2024-02-15', 'LEAF_DONE')`,
          [RUN_ID],
        ),
      ).rejects.toThrow();
    });

    it('lets secondary leaves of the same day coexist, because they are filtered by class', async () => {
      await seedSiteAndRun(db);
      await db.query(
        `INSERT INTO juris.partition (site, id, run_id, data_ini, data_fim, facets, status)
         VALUES ('t', 'c1', $1, '2024-03-01', '2024-03-01', '{"classe":"APELAÇÃO CÍVEL"}', 'LEAF_DONE')`,
        [RUN_ID],
      );
      const res = await db.query(
        `INSERT INTO juris.partition (site, id, run_id, data_ini, data_fim, facets, status)
         VALUES ('t', 'c2', $1, '2024-03-01', '2024-03-01', '{"classe":"MANDADO DE SEGURANÇA"}', 'LEAF_DONE')`,
        [RUN_ID],
      );
      expect(res.rowCount).toBe(1);
    });

    it('rejects a case_record whose partition range is inverted', async () => {
      await seedSiteAndRun(db);
      await expect(
        db.query(
          `INSERT INTO juris.case_record
             (site, id_origem, numero, numero_norm, classe, assunto_resumo,
              data_autuacao_ini, data_autuacao_fim, partes_resumo, estado, content_hash, listed_at)
           VALUES ('t','1','n','n','c','a','2024-05-15','2024-05-01','p','LISTED','h', now())`,
        ),
      ).rejects.toThrow();
    });

    it('rejects a job with an unknown kind and dedupes on (site, key)', async () => {
      await seedSiteAndRun(db);
      await expect(
        db.query(
          `INSERT INTO juris.job (site, kind, key, payload) VALUES ('t','nonsense','k','{}')`,
        ),
      ).rejects.toThrow();

      await db.query(
        `INSERT INTO juris.job (site, kind, key, payload) VALUES ('t','detail','d:1','{}')`,
      );
      await expect(
        db.query(
          `INSERT INTO juris.job (site, kind, key, payload) VALUES ('t','detail','d:1','{}')`,
        ),
      ).rejects.toThrow();
    });
  });
}

const RUN_ID = '00000000-0000-4000-8000-000000000001';

/** The catalog rows every other table points at. Safe to call repeatedly. */
async function seedSiteAndRun(db: SqlExecutor): Promise<void> {
  await db.query(
    `INSERT INTO juris.site (id, country, name, base_url, timezone)
     VALUES ('t', 'BR', 'test', 'http://localhost', 'America/Recife')
     ON CONFLICT (id) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO juris.crawl_run (run_id, site, root_ini, root_fim, config, version)
     VALUES ($1, 't', '2024-01-01', '2024-12-31', '{}', 'test')
     ON CONFLICT (run_id) DO NOTHING`,
    [RUN_ID],
  );
}
