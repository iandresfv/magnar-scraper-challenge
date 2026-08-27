/**
 * The dead letter queue commands.
 *
 * There is no separate DLQ table. A job that exhausted its retries is a row with
 * `status = 'dead'`, carrying its failure class, its attempt count, its last error and its
 * timestamps. That is worth saying plainly because it is what makes these two commands almost
 * trivial — `dlq:list` is a SELECT and `retry-dlq` is an UPDATE — and it is what lets anyone
 * with `psql` answer a question the CLI did not anticipate.
 *
 * The philosophy is that a run which ends with dead jobs is **not clean**, and says so with exit
 * code 1. Hiding that behind a success would be the easiest possible way to make a report look
 * better than the data behind it.
 */
import { ExitCode } from '../../core/domain/types.js';
import type { Job, JobKind, JobQueue } from '../../core/ports/jobQueue.js';

export interface DlqListOptions {
  site: string;
  kind?: JobKind | undefined;
  limit?: number;
  write?: (line: string) => void;
}

export async function dlqListCommand(queue: JobQueue, options: DlqListOptions): Promise<number> {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const dead = await queue.listDead(options.site, {
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    limit: options.limit ?? 100,
  });

  if (dead.length === 0) {
    write(
      `no dead jobs for ${options.site}${options.kind === undefined ? '' : ` (kind ${options.kind})`}`,
    );
    return ExitCode.OK;
  }

  write(formatTable(dead));
  write('');
  write(`${String(dead.length)} dead job(s). Reprocess them with: npm run retry-dlq`);

  // Listing the problem is not solving it: the exit code still says the run is not clean.
  return ExitCode.DEAD_JOBS_REMAIN;
}

export interface RetryDlqOptions {
  site: string;
  kind?: JobKind | undefined;
  limit?: number;
  write?: (line: string) => void;
}

export async function retryDlqCommand(queue: JobQueue, options: RetryDlqOptions): Promise<number> {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));

  const before = await queue.stats(options.site);
  if (before.dead === 0) {
    write(`nothing to reprocess: ${options.site} has no dead jobs`);
    return ExitCode.OK;
  }

  const revived = await queue.revive(options.site, {
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  const after = await queue.stats(options.site);
  write(
    `moved ${String(revived)} job(s) back to pending` +
      (options.kind === undefined ? '' : ` (kind ${options.kind})`),
  );
  write(`${String(after.dead)} still dead · ${String(after.pending)} now pending`);
  write('Run the crawl again to work through them.');
  return ExitCode.OK;
}

/** A plain fixed-width table. Readable in a terminal, greppable in a log, no dependency. */
function formatTable(jobs: readonly Job[]): string {
  const rows = jobs.map((job) => ({
    key: job.key,
    kind: job.kind,
    failure: job.failureClass ?? '—',
    attempts: `${String(job.attempts)}/${String(job.maxAttempts)}`,
    status: job.httpStatus === null ? '—' : String(job.httpStatus),
    error: truncate(job.lastError ?? '', 60),
  }));

  const columns = [
    { header: 'KEY', get: (r: (typeof rows)[number]) => r.key },
    { header: 'KIND', get: (r: (typeof rows)[number]) => r.kind },
    { header: 'FAILURE', get: (r: (typeof rows)[number]) => r.failure },
    { header: 'TRIES', get: (r: (typeof rows)[number]) => r.attempts },
    { header: 'HTTP', get: (r: (typeof rows)[number]) => r.status },
    { header: 'LAST ERROR', get: (r: (typeof rows)[number]) => r.error },
  ];

  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => column.get(row).length)),
  );

  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();

  return [
    line(columns.map((c) => c.header)),
    line(widths.map((w) => '─'.repeat(w))),
    ...rows.map((row) => line(columns.map((c) => c.get(row)))),
  ].join('\n');
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
