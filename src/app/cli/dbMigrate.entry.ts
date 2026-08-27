/**
 * Thin entry point for `npm run db:migrate`. The composition root proper (`app/main.ts`) grows
 * a real command dispatcher in Fase 3; until then each command has a one-file entry so it can
 * be exercised on its own.
 */
import { dbMigrateCommand } from '../commands/dbMigrate.js';

const driver = process.env['DB_DRIVER'];
process.exitCode = await dbMigrateCommand({
  driver: driver === 'pg' || driver === 'pglite' ? driver : undefined,
  databaseUrl: process.env['DATABASE_URL'],
  dbPath: process.env['DB_PATH'],
});
