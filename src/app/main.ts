/**
 * Process entry point.
 *
 * Responsibility: parse the command line, wire the ports to their adapters and hand control
 * to a command. Today it only reports the version — the composition root grows in Fase 3,
 * when the crawl command and the planner/worker roles land.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './version.js';

export function main(): number {
  process.stdout.write(`juris-scraper ${resolveVersion()}\n`);
  return 0;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main();
}
