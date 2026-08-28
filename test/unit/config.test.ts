/**
 * Configuration, and the value that is not a value.
 *
 * `.env.example` ships several keys blank on purpose — `ROOT_END=` documents that the default is
 * computed, `METRICS_PORT=` that the endpoint is off. Copying that file and running the first
 * command in the README was a configuration error until an empty value counted as unset.
 */
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/app/config.js';

describe('an empty variable', () => {
  it('reads as unset, which is what the shipped example file relies on', () => {
    // `.env.example` ships ROOT_END= and METRICS_PORT= blank to document their defaults.
    const config = resolveConfig({
      argv: ['crawl'],
      env: { ROOT_END: '', METRICS_PORT: '', WORKER_ID: '  ', DB_DRIVER: '', SITE_BASE_URL: '' },
      now: () => new Date('2026-08-27T00:00:00Z'),
    });

    // 366 días por delante: el default computado, no un error de configuración.
    expect(config.crawl.root.fim).toBe('2027-08-28');
    expect(config.metricsPort).toBeNull();
    expect(config.crawl.workerId).not.toBe('');
    expect(config.db.driver).toBeUndefined();
    expect(config.baseUrl).toBeUndefined();
  });
});
