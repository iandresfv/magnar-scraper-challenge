/**
 * `healthcheck` — is this container worth keeping?
 *
 * Docker's `HEALTHCHECK` runs it every interval, so it has to be cheap, has to answer honestly,
 * and must never repair anything: a probe that migrates the schema to make itself pass is a probe
 * that hides the outage it exists to report.
 *
 * The bar is deliberately "can this process do its job", not "is the crawl going well". A worker
 * that is politely waiting out a 429 is healthy; a worker that cannot reach Postgres is not,
 * because everything it does — the queue, the checkpoint, the coverage tree — is in Postgres.
 */
import { ExitCode } from '../../core/domain/types.js';
import type { SqlExecutor } from '../../core/ports/sql.js';

export interface HealthcheckOptions {
  db: SqlExecutor;
  /** When set, the local `/healthz` of the metrics endpoint is probed too. */
  metricsPort?: number | null;
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
}

export interface HealthCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export async function healthcheckCommand(options: HealthcheckOptions): Promise<number> {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const checks: HealthCheckResult[] = [await database(options.db)];

  if (options.metricsPort !== undefined && options.metricsPort !== null) {
    checks.push(await metricsEndpoint(options.metricsPort, options.fetchImpl ?? fetch));
  }

  for (const check of checks) {
    write(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name.padEnd(9)} ${check.detail}`);
  }
  return checks.every((check) => check.ok) ? ExitCode.OK : ExitCode.SANITY_FAILED;
}

async function database(db: SqlExecutor): Promise<HealthCheckResult> {
  try {
    const { rows } = await db.query<{ version: string; applied: string }>(
      `SELECT max(version) AS version, count(*)::text AS applied FROM juris.schema_migration`,
    );
    const applied = Number(rows[0]?.applied ?? 0);
    return applied === 0
      ? { name: 'database', ok: false, detail: 'reachable, but no migration has been applied' }
      : {
          name: 'database',
          ok: true,
          detail: `reachable · ${String(applied)} migration(s) · at ${rows[0]?.version ?? '?'}`,
        };
  } catch (error) {
    return {
      name: 'database',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function metricsEndpoint(port: number, fetchImpl: typeof fetch): Promise<HealthCheckResult> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${String(port)}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return {
      name: 'metrics',
      ok: response.status === 200,
      detail: `/healthz answered ${String(response.status)}`,
    };
  } catch (error) {
    return {
      name: 'metrics',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
