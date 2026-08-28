/**
 * `.env`, loaded by the process itself.
 *
 * The architecture says configuration comes from `node --env-file=.env`, and the README tells the
 * reader to copy `.env.example` and run `npm start`. Those two sentences did not meet: the npm
 * scripts run through `tsx`, nobody passed the flag, and the file was silently ignored — a crawl
 * that quietly used PGlite while the reader believed it was writing to their Postgres.
 *
 * The flag's own alternative (`--env-file-if-exists`) needs Node ≥ 20.12, and this project
 * promises 20.6. So the loading happens here, in about twenty lines, with the same rule the flag
 * has: **the real environment always wins**, because a value exported in a shell or set by
 * `docker compose` is more specific than a file checked into a directory.
 *
 * It is not a configuration library. It reads `KEY=value` lines, ignores comments and blanks, and
 * strips one layer of matching quotes. Anything more elaborate belongs in the shell.
 */
import { readFileSync } from 'node:fs';

export interface LoadEnvOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

/** Returns the keys it actually set, so a caller can say so out loud. */
export function loadEnvFile(options: LoadEnvOptions = {}): string[] {
  const path = options.path ?? '.env';
  const env = options.env ?? process.env;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // No file is the normal case: containers get their environment from compose.
    return [];
  }

  const applied: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (env[key] !== undefined) continue;

    env[key] = unquote(trimmed.slice(eq + 1).trim());
    applied.push(key);
  }
  return applied;
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted && value.length >= 2 ? value.slice(1, -1) : value;
}
