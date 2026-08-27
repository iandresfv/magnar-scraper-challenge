/**
 * Resolves the package version at runtime.
 *
 * Responsibility: give every command, log line and report a single source for the version
 * string. Invariant: it is read from `package.json`, never duplicated in code, so a release
 * bump cannot leave a stale version behind in the output.
 *
 * The lookup walks up from this module because the file sits at `src/app/` in development
 * (run through tsx) and at `dist/app/` once built; both are one directory below the package
 * root's child, so a walk is more honest than a hardcoded `../..`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hops = 0; hops < 6; hops++) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
        const { version } = parsed;
        if (typeof version === 'string') return version;
      }
    } catch {
      // Not this directory; keep walking towards the package root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0-unknown';
}
