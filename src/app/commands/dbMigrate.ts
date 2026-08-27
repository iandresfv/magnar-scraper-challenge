/**
 * `npm run db:migrate` — applies pending migrations against whichever driver the configuration
 * selects, and says which one that was. Exits 0 when the schema is already current.
 */
import { createSqlExecutor } from '../../infra/db/factory.js';
import { migrate } from '../../infra/db/migrator.js';

export interface DbMigrateOptions {
  driver?: 'pg' | 'pglite' | undefined;
  databaseUrl?: string | undefined;
  dbPath?: string | undefined;
  write?: (line: string) => void;
}

export async function dbMigrateCommand(options: DbMigrateOptions = {}): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const { executor, fallbackNotice } = await createSqlExecutor({
    driver: options.driver,
    databaseUrl: options.databaseUrl,
    dbPath: options.dbPath,
  });
  if (fallbackNotice !== null) write(fallbackNotice);

  try {
    const { applied, skipped } = await migrate(executor);
    write(`driver=${executor.driver} target=${executor.target}`);
    for (const m of applied) write(`applied  ${String(m.version).padStart(3, '0')}_${m.name}`);
    write(
      applied.length === 0
        ? `schema already current (${String(skipped.length)} migration(s) on record)`
        : `${String(applied.length)} migration(s) applied`,
    );
    return 0;
  } finally {
    await executor.close();
  }
}
