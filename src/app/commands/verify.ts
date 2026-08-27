/**
 * `npm run verify` — is the last run trustworthy?
 *
 * Prints every check with its evidence, not only the failures, because a reader deciding whether
 * to believe a dataset needs to see what was examined as much as what went wrong. Exits 4 if any
 * `error` check failed, which makes it usable as a gate in a pipeline.
 */
import { ExitCode } from '../../core/domain/types.js';
import type { Repos } from '../../core/ports/repos.js';
import type { SqlExecutor } from '../../core/ports/sql.js';
import type { HttpPort } from '../../core/ports/http.js';
import type { SiteAdapter } from '../../core/ports/siteAdapter.js';
import { sampleDrift, verifyRun, type VerifyReport } from '../../core/usecases/verifyRun.js';

export interface VerifyOptions {
  db: SqlExecutor;
  repos: Repos;
  site: string;
  /** Defaults to the most recent run for the site. */
  runId?: string;
  /** How many leaves to re-query against the live site. Zero means no network at all. */
  sample?: number;
  adapter?: SiteAdapter;
  http?: HttpPort;
  write?: (line: string) => void;
}

export async function verifyCommand(options: VerifyOptions): Promise<number> {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));

  const run =
    options.runId === undefined
      ? await options.repos.runs.latest(options.site)
      : await options.repos.runs.get(options.runId);
  if (run === null) {
    write(`no run to verify for site ${options.site}`);
    return ExitCode.SANITY_FAILED;
  }

  const report = await verifyRun({
    db: options.db,
    repos: options.repos,
    site: options.site,
    runId: run.runId,
    root: run.root,
  });

  write(`verifying run ${run.runId} · site ${run.site} · root ${run.root.ini}..${run.root.fim}`);
  write('');
  for (const check of report.checks) {
    const mark = check.ok ? 'ok  ' : check.severity === 'error' ? 'FAIL' : 'warn';
    write(`${mark} ${check.id.padEnd(5)} ${check.title}`);
    write(`          ${check.detail}`);
  }

  // The drift sample is last because it is the only one that touches the network, and because a
  // reader who has already seen a failure above may not want to spend requests on a tribunal.
  let drifted = 0;
  if ((options.sample ?? 0) > 0 && options.adapter !== undefined && options.http !== undefined) {
    const adapter = options.adapter;
    const http = options.http;
    const session = await adapter.bootstrap(http);
    const result = await sampleDrift({
      repos: options.repos,
      runId: run.runId,
      sampleSize: options.sample ?? 0,
      search: async (range, facets) => {
        const page = await adapter.search(http, session, { range, facets });
        return page.rows.length;
      },
    });
    drifted = result.drifted;

    write('');
    write(`re-queried ${String(result.samples.length)} leaf/leaves against the live site:`);
    for (const sample of result.samples) {
      write(
        `  ${sample.drifted ? 'drift' : 'same '} ${sample.partitionId}: ` +
          `stored ${String(sample.storedRows)}, now ${String(sample.observedRows)}`,
      );
    }
    if (drifted > 0) {
      write(
        `  ${String(drifted)} leaf/leaves changed since the crawl. The report still describes ` +
          `what was true when it ran; re-crawl to bring it up to date.`,
      );
    }
  }

  write('');
  write(summarise(report, drifted));
  return report.ok ? ExitCode.OK : ExitCode.SANITY_FAILED;
}

function summarise(report: VerifyReport, drifted: number): string {
  const passed = report.checks.filter((c) => c.ok).length;
  const parts = [
    `${String(passed)}/${String(report.checks.length)} checks passed`,
    report.errors > 0 ? `${String(report.errors)} error(s)` : null,
    report.warnings > 0 ? `${String(report.warnings)} warning(s)` : null,
    drifted > 0 ? `${String(drifted)} leaf/leaves drifted` : null,
  ].filter((part): part is string => part !== null);

  return report.ok
    ? `${parts.join(' · ')} — this run can be trusted`
    : `${parts.join(' · ')} — this run should NOT be trusted until the errors above are explained`;
}
