/**
 * One contract suite, two drivers.
 *
 * This is the file that makes "PGlite is a fallback, not a second backend" a checkable claim
 * rather than a slogan. Everything the repositories rely on is asserted here against both
 * `pg` (when `TEST_DATABASE_URL` is set) and PGlite (always).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';

export interface ExecutorUnderTest {
  name: string;
  create: () => Promise<SqlExecutor>;
}

export function runSqlExecutorContract(subject: ExecutorUnderTest): void {
  describe(`SqlExecutor contract: ${subject.name}`, () => {
    let db: SqlExecutor;
    const table = `contract_${Math.abs(hash(subject.name))}`;

    beforeAll(async () => {
      db = await subject.create();
      await db.query(`DROP TABLE IF EXISTS ${table}`);
      await db.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, label text NOT NULL)`);
    });

    afterAll(async () => {
      await db.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
      await db.close();
    });

    it('runs a trivial query', async () => {
      const res = await db.query<{ one: number }>('SELECT 1 AS one');
      expect(res.rows[0]?.one).toBe(1);
    });

    it('binds parameters positionally and does not interpolate', async () => {
      const res = await db.query<{ value: string }>('SELECT $1::text AS value', [
        "Robert'); DROP TABLE students;--",
      ]);
      expect(res.rows[0]?.value).toBe("Robert'); DROP TABLE students;--");
    });

    it('preserves non-ascii text unchanged', async () => {
      const res = await db.query<{ value: string }>('SELECT $1::text AS value', ['APELAÇÃO CÍVEL']);
      expect(res.rows[0]?.value).toBe('APELAÇÃO CÍVEL');
    });

    it('returns a date as a plain YYYY-MM-DD string, with no timezone applied', async () => {
      // A partition boundary has no time and no zone. Both drivers must agree, or a leaf could
      // silently shift by a day depending on where the process runs.
      const res = await db.query<{ d: string }>("SELECT '2024-05-15'::date AS d");
      expect(res.rows[0]?.d).toBe('2024-05-15');
    });

    it('reports rowCount for writes', async () => {
      const res = await db.query(`INSERT INTO ${table} (id, label) VALUES ($1, $2)`, [1, 'first']);
      expect(res.rowCount).toBe(1);
    });

    it('commits a transaction that resolves', async () => {
      await db.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${table} (id, label) VALUES ($1, $2)`, [10, 'committed']);
        await tx.query(`INSERT INTO ${table} (id, label) VALUES ($1, $2)`, [11, 'committed']);
      });
      const res = await db.query(`SELECT id FROM ${table} WHERE id IN (10, 11)`);
      expect(res.rows).toHaveLength(2);
    });

    it('rolls back a transaction that throws, and rethrows the original error', async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${table} (id, label) VALUES ($1, $2)`, [20, 'doomed']);
          throw new Error('deliberate failure');
        }),
      ).rejects.toThrow('deliberate failure');

      const res = await db.query(`SELECT id FROM ${table} WHERE id = 20`);
      expect(res.rows).toHaveLength(0);
    });

    it('rolls back when the failure is a constraint violation, not a thrown Error', async () => {
      await db.query(`INSERT INTO ${table} (id, label) VALUES ($1, $2)`, [30, 'original']);
      await expect(
        db.transaction(async (tx) => {
          await tx.query(`INSERT INTO ${table} (id, label) VALUES ($1, $2)`, [31, 'fine']);
          await tx.query(`INSERT INTO ${table} (id, label) VALUES ($1, $2)`, [30, 'duplicate']);
        }),
      ).rejects.toThrow();

      const res = await db.query(`SELECT id FROM ${table} WHERE id = 31`);
      expect(res.rows).toHaveLength(0);
    });

    it('keeps working after a rolled back transaction', async () => {
      // A driver that leaves the connection in a failed transaction state would break here.
      const res = await db.query<{ one: number }>('SELECT 1 AS one');
      expect(res.rows[0]?.one).toBe(1);
    });

    it('supports btree_gist, which the partition tiling constraint depends on', async () => {
      await db.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
      const excl = `${table}_excl`;
      await db.query(`DROP TABLE IF EXISTS ${excl}`);
      await db.query(
        `CREATE TABLE ${excl} (
           site text NOT NULL,
           ini date NOT NULL,
           fim date NOT NULL,
           EXCLUDE USING gist (site WITH =, daterange(ini, fim, '[]') WITH &&)
         )`,
      );
      await db.query(`INSERT INTO ${excl} VALUES ('a', '2024-01-01', '2024-01-31')`);
      // A different site may overlap freely; the same site may not.
      await db.query(`INSERT INTO ${excl} VALUES ('b', '2024-01-15', '2024-02-15')`);
      await expect(
        db.query(`INSERT INTO ${excl} VALUES ('a', '2024-01-15', '2024-02-15')`),
      ).rejects.toThrow();
      await db.query(`DROP TABLE ${excl}`);
    });

    it('reports its driver and a target with no password in it', () => {
      expect(['pg', 'pglite']).toContain(db.driver);
      // The target is logged on every start-up, so the real password must not survive into it.
      // The redaction marker may — that is the point of it.
      expect(db.target).not.toContain(':juris@');
    });
  });
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}
