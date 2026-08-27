/**
 * Process entry point and composition root.
 *
 * This is the only file allowed to know about every layer at once: it reads the configuration,
 * picks the drivers, builds the adapter, and hands the wired-up pieces to a command. Everything
 * below it is talking to interfaces.
 *
 * Signals are handled here rather than inside the crawl, because "stop soon" is a property of
 * the process, not of the algorithm. The first `SIGINT` asks the loop to finish its current job
 * and checkpoint; a second one, from an impatient operator, exits immediately — the state is in
 * Postgres either way, so the worst case is one job's lease waiting to expire.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExitCode } from '../core/domain/types.js';
import { createSqlExecutor } from '../infra/db/factory.js';
import { migrate } from '../infra/db/migrator.js';
import { createRepos } from '../infra/db/repos/index.js';
import { PgJobQueue } from '../infra/db/pgJobQueue.js';
import { PgThrottle } from '../infra/db/pgThrottle.js';
import type { JobKind } from '../core/ports/jobQueue.js';
import { FetchHttpClient } from '../infra/http/fetchHttpClient.js';
import { createBlobStore } from '../infra/blob/factory.js';
import { MetricsRegistry } from '../infra/metrics/registry.js';
import { startMetricsServer } from '../infra/metrics/server.js';
import { crawlCommand } from './commands/crawl.js';
import { dlqListCommand, retryDlqCommand } from './commands/dlq.js';
import { verifyCommand } from './commands/verify.js';
import { reportCommand } from './commands/report.js';
import { exportCommand, type ExportFormat } from './commands/export.js';
import { healthcheckCommand } from './commands/healthcheck.js';
import { ConfigError, resolveConfig, type Config } from './config.js';
import { createSite } from './registry.js';
import { resolveVersion } from './version.js';

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  let config: Config;
  try {
    config = resolveConfig({ argv });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      return ExitCode.SANITY_FAILED;
    }
    throw error;
  }

  if (config.command === 'version' || argv.includes('--version')) {
    write(`juris-scraper ${resolveVersion()}`);
    return ExitCode.OK;
  }

  // No command at all prints usage rather than starting a crawl. Beginning a run that talks to a
  // public court server because somebody typed the binary's name to see what it was would be a
  // rude default, and an evaluator's first instinct is exactly that.
  if (argv.length === 0 || config.command === 'help' || argv.includes('--help')) {
    write(usage());
    return ExitCode.OK;
  }

  const { executor, fallbackNotice } = await createSqlExecutor({
    driver: config.db.driver,
    databaseUrl: config.db.url,
    dbPath: config.db.path,
  });
  if (fallbackNotice !== null) write(fallbackNotice);

  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = (): void => {
    interrupts++;
    if (interrupts === 1) {
      write('\nstopping after the current job; press Ctrl+C again to exit immediately');
      controller.abort();
    } else {
      write('\nexiting now; the run is checkpointed in the database');
      process.exit(ExitCode.INTERRUPTED);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    // The healthcheck never migrates: a probe that repairs the thing it measures always passes.
    if (config.db.autoMigrate && config.command !== 'healthcheck') {
      const { applied } = await migrate(executor);
      if (applied.length > 0) write(`applied ${String(applied.length)} migration(s)`);
    }

    const repos = createRepos(executor);
    const queue = new PgJobQueue(executor, { defaultLeaseMs: config.crawl.leaseMs });
    const http = new FetchHttpClient();
    const adapter = createSite(
      config.site,
      config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl },
    );

    switch (config.command) {
      case 'crawl': {
        const blob = await createBlobStore({
          driver: config.blob.driver,
          dir: config.blob.dir,
          endpoint: config.blob.endpoint,
          bucket: config.blob.bucket,
          region: config.blob.region,
          accessKeyId: config.blob.accessKeyId,
          secretAccessKey: config.blob.secretAccessKey,
          forcePathStyle: config.blob.forcePathStyle,
        });
        if (blob.fallbackNotice !== null) write(blob.fallbackNotice);
        await blob.store.init();

        const metrics = new MetricsRegistry();
        const metricsServer =
          config.metricsPort === null
            ? null
            : await startMetricsServer(metrics, { port: config.metricsPort });
        if (metricsServer !== null) {
          write(`metrics on http://localhost:${String(metricsServer.port)}/metrics`);
        }

        try {
          const result = await crawlCommand({
            throttle: new PgThrottle(executor),
            store: blob.store,
            metrics,
            config,
            adapter,
            http,
            db: executor,
            repos,
            queue,
            signal: controller.signal,
            log: write,
          });
          return result.exitCode;
        } finally {
          await metricsServer?.close();
        }
      }
      case 'dlq:list':
      case 'dlq-list': {
        return dlqListCommand(queue, {
          site: config.site,
          kind: jobKindOf(argv),
          write,
        });
      }
      case 'verify': {
        const sample = Number(flagValue(argv, '--sample') ?? '0');
        return verifyCommand({
          db: executor,
          repos,
          site: config.site,
          sample,
          ...(sample > 0 ? { adapter, http } : {}),
          write,
        });
      }
      case 'report': {
        const outDir = flagValue(argv, '--out');
        const sampleSize = flagValue(argv, '--sample');
        // `--no-anonymize` has to be asked for explicitly: the default writes a file that is safe
        // to commit, and the unsafe variant should be a deliberate keystroke.
        return reportCommand({
          db: executor,
          repos,
          site: config.site,
          anonymize: !argv.includes('--no-anonymize'),
          ...(outDir === undefined ? {} : { outDir }),
          ...(sampleSize === undefined ? {} : { sampleSize: Number(sampleSize) }),
          write,
        });
      }
      case 'export': {
        const format = flagValue(argv, '--format') ?? 'jsonl';
        if (format !== 'jsonl' && format !== 'csv') {
          process.stderr.write(`unknown --format "${format}"; expected jsonl or csv\n`);
          return ExitCode.SANITY_FAILED;
        }
        const out = flagValue(argv, '--out');
        const only = flagValue(argv, '--only');
        const result = await exportCommand({
          db: executor,
          site: config.site,
          format: format satisfies ExportFormat,
          anonymize: argv.includes('--anonymize'),
          ...(out === undefined ? {} : { outDir: out }),
          ...(only === undefined ? {} : { only: only.split(',').map((name) => name.trim()) }),
          write,
        });
        return result.exitCode;
      }
      case 'healthcheck': {
        return healthcheckCommand({ db: executor, metricsPort: config.metricsPort, write });
      }
      case 'retry-dlq': {
        return retryDlqCommand(queue, {
          site: config.site,
          kind: jobKindOf(argv),
          write,
        });
      }
      default: {
        process.stderr.write(
          `unknown command "${config.command}". Known commands: crawl, dlq:list, retry-dlq, verify, report, export, healthcheck\n`,
        );
        return ExitCode.SANITY_FAILED;
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await executor.close();
  }
}

/** Reads a `--flag value` pair out of the raw argv. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** `--kind blob` narrows the DLQ commands to one sort of work. */
function jobKindOf(argv: readonly string[]): JobKind | undefined {
  const index = argv.indexOf('--kind');
  const value = index === -1 ? undefined : argv[index + 1];
  return value === 'search' || value === 'detail' || value === 'blob' || value === 'verify'
    ? value
    : undefined;
}

function usage(): string {
  return [
    `juris-scraper ${resolveVersion()} — multi-site judicial scraping engine`,
    '',
    'Usage: node dist/app/main.js <command> [options]',
    '',
    'Commands:',
    '  crawl        crawl a site to completion, resuming any unfinished run',
    '  dlq:list     list the jobs that exhausted their retries',
    '  verify       run the sanity checks over the last run; exits 4 if any fail',
    '  report       write reports/coverage.md, coverage.json, metrics.json and sample.md',
    '  export       write one jsonl or csv file per entity into exports/',
    '  retry-dlq    move dead jobs back to pending so the next crawl reprocesses them',
    '  healthcheck  probe the database (and /healthz); exits 4 when unhealthy',
    '  version      print the version and exit',
    '',
    'Options:',
    '  --site <id>            which site to crawl (default: br-trf5)',
    '  --base-url <url>       override the site base url (needed by fake-pje)',
    '  --role all|planner|worker',
    '  --root-start <date>    first day of the search space (default: 1990-01-01)',
    '  --root-end <date>      last day (default: one year from today)',
    '  --pdf-budget <n|all>   how many PDFs this run may fetch (default: 150)',
    '  --max-jobs <n>         stop after n jobs, for a bounded demo',
    '  --kind <k>             narrow dlq:list / retry-dlq to search|detail|blob',
    '  --sample <n>           verify: re-query n leaves against the live site',
    '                         report: how many cases to render in sample.md (default: 10)',
    '  --out <dir>            report/export: where to write (default: reports / exports)',
    '  --format jsonl|csv     export: output format (default: jsonl)',
    '  --only <a,b>           export: only these entities (default: all)',
    '  --anonymize            export: mask CPF/CNPJ digits in the output',
    '  --no-anonymize         report: leave CPF/CNPJ unmasked; do not commit the result',
    '',
    'Configuration also reads the environment; see .env.example.',
  ].join('\n');
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
  process.exitCode = await main();
}
