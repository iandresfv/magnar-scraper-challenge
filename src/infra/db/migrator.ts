/**
 * Migration runner. About forty lines, on purpose.
 *
 * Responsibility: apply every `NNN_name.sql` under `migrations/` exactly once, in numeric
 * order, each inside its own transaction, recording what was applied in
 * `juris.schema_migration`.
 *
 * Invariants:
 *   · Idempotent. Running it twice is a no-op, which is what makes `DB_AUTO_MIGRATE=true` safe
 *     as a default in development and in compose.
 *   · A migration that fails rolls back whole. There is no half-applied schema to reason about.
 *   · The checksum of an already-applied file is compared on every run. Editing a migration
 *     that has shipped is a mistake that is much cheaper to catch here than in production.
 *
 * There is no `down`. Rolling a schema backwards automatically is a promise this project does
 * not need to make; a forward migration that undoes something is clearer and reviewable.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlExecutor } from '../../core/ports/sql.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationOutcome {
  applied: Migration[];
  skipped: Migration[];
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => FILE_PATTERN.test(f));
  const migrations = files.map((file) => {
    const match = FILE_PATTERN.exec(file);
    // The filter above guarantees a match; this keeps the compiler honest without a cast.
    if (match === null) throw new Error(`unreachable: ${file}`);
    const sql = readFileSync(join(dir, file), 'utf8');
    return {
      version: Number(match[1]),
      name: match[2] ?? file,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
  migrations.sort((a, b) => a.version - b.version);

  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) throw new Error(`duplicate migration version ${m.version}`);
    seen.add(m.version);
  }
  return migrations;
}

export async function migrate(db: SqlExecutor, dir?: string): Promise<MigrationOutcome> {
  await db.query(`CREATE SCHEMA IF NOT EXISTS juris`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS juris.schema_migration (
       version    integer PRIMARY KEY,
       name       text NOT NULL,
       checksum   text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const { rows } = await db.query<{ version: string | number; name: string; checksum: string }>(
    `SELECT version, name, checksum FROM juris.schema_migration`,
  );
  const already = new Map(rows.map((r) => [Number(r.version), r]));

  const applied: Migration[] = [];
  const skipped: Migration[] = [];

  for (const migration of loadMigrations(dir)) {
    const previous = already.get(migration.version);
    if (previous !== undefined) {
      if (previous.checksum !== migration.checksum) {
        throw new Error(
          `migration ${String(migration.version)}_${migration.name} changed after it was applied ` +
            `(recorded ${previous.checksum.slice(0, 12)}, file ${migration.checksum.slice(0, 12)}). ` +
            `Add a new migration instead of editing one that has shipped.`,
        );
      }
      skipped.push(migration);
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.execScript(migration.sql);
      await tx.query(
        `INSERT INTO juris.schema_migration (version, name, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
    });
    applied.push(migration);
  }

  return { applied, skipped };
}
