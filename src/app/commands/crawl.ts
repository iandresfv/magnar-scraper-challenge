/**
 * `crawl` — the command that runs everything.
 *
 * One binary, three roles, chosen with a flag:
 *
 *   · **planner** seeds the root partition, recovers leases whose workers died, and reports
 *     progress. One per site.
 *   · **worker** claims jobs and runs them. As many as you like; `SKIP LOCKED` keeps them from
 *     colliding and the shared throttle keeps them from multiplying the pressure on the court.
 *   · **all** does both in one process, which is what `npm start` uses and what an evaluator
 *     without Docker gets.
 *
 * That split is the whole horizontal-scaling story, and it is why `docker compose --scale
 * worker=3` needs no coordinator: the queue *is* the coordination.
 *
 * Shutdown is deliberate. `SIGINT`/`SIGTERM` stop the loop between jobs rather than mid-request,
 * the in-flight job's lease is released so somebody else can take it immediately instead of
 * waiting for it to expire, and the exit code says what happened.
 */
import { randomUUID } from 'node:crypto';
import { ExitCode, type PartitionNode } from '../../core/domain/types.js';
import type { GapEvidence } from '../../core/engine/coverageEngine.js';
import { newPartitionNode } from '../../core/engine/partitionTree.js';
import { Pipeline } from '../../core/engine/pipeline.js';
import { SearchHandler } from '../../core/engine/handlers/search.js';
import { DetailHandler } from '../../core/engine/handlers/detail.js';
import type { JobQueue } from '../../core/ports/jobQueue.js';
import type { Repos } from '../../core/ports/repos.js';
import type { SqlExecutor } from '../../core/ports/sql.js';
import type { HttpPort } from '../../core/ports/http.js';
import type { SiteAdapter, SiteSession } from '../../core/ports/siteAdapter.js';
import { SiteChangedError } from '../../core/ports/siteAdapter.js';
import type { Config } from '../config.js';

export interface CrawlDeps {
  config: Config;
  adapter: SiteAdapter;
  http: HttpPort;
  db: SqlExecutor;
  repos: Repos;
  queue: JobQueue;
  now?: () => Date;
  log?: (line: string) => void;
  /** Overrides the wall clock in tests so a progress interval does not slow a suite down. */
  progressEveryMs?: number;
  signal?: AbortSignal;
}

export interface CrawlResult {
  runId: string;
  exitCode: number;
  jobsRun: number;
  gaps: { node: PartitionNode; evidence: GapEvidence }[];
  canary: { id: string; message: string } | null;
  stats: Awaited<ReturnType<JobQueue['stats']>>;
}

export async function crawlCommand(deps: CrawlDeps): Promise<CrawlResult> {
  const { config, adapter, http, db, repos, queue } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const log =
    deps.log ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const site = adapter.descriptor.id;

  await repos.site.ensure({
    id: site,
    country: adapter.descriptor.country,
    name: adapter.descriptor.name,
    baseUrl: adapter.descriptor.baseUrl,
    timezone: adapter.descriptor.timezone,
  });

  // Resume rather than restart: a run whose root matches and which never finished is this one.
  const previous = await repos.runs.latest(site);
  const resuming =
    previous !== null &&
    previous.finishedAt === null &&
    previous.root.ini === config.crawl.root.ini &&
    previous.root.fim === config.crawl.root.fim;
  const runId = resuming ? previous.runId : randomUUID();

  if (!resuming) {
    await repos.runs.start({
      runId,
      site,
      startedAt: now().toISOString(),
      finishedAt: null,
      root: config.crawl.root,
      config: {
        role: config.role,
        pdfBudget: config.crawl.pdfBudget,
        concurrency: config.throttle.concurrency,
      },
      version: '0.1.0',
      exitCode: null,
      summary: null,
    });
  }
  log(
    `${resuming ? 'resuming' : 'starting'} run ${runId} · site ${site} · ` +
      `root ${config.crawl.root.ini}..${config.crawl.root.fim} · role ${config.role}`,
  );

  // ── the session, shared by the handlers and replaced when it dies ──────────
  let session: SiteSession | null = null;
  const getSession = async (): Promise<SiteSession> => {
    session ??= await adapter.bootstrap(http);
    return session;
  };
  const renewSession = async (): Promise<SiteSession> => {
    const current = await getSession();
    session = await adapter.renew(http, current, 'SESSION_LOST');
    return session;
  };

  const gaps: { node: PartitionNode; evidence: GapEvidence }[] = [];
  let blobsQueued = 0;

  const pipeline = new Pipeline()
    .register(
      new SearchHandler({
        adapter,
        db,
        queue,
        cases: repos.cases,
        partitions: repos.partitions,
        vocabulary: repos.vocabulary,
        session: getSession,
        http,
        now,
        onGap: (node, evidence) => {
          gaps.push({ node, evidence });
          log(
            `GAP ${node.id}: ${String(evidence.visibleRows)} rows visible, ` +
              `none of [${evidence.axesTried.join(', ')}] could divide it`,
          );
        },
      }),
    )
    .register(
      new DetailHandler({
        adapter,
        http,
        db,
        queue,
        cases: repos.cases,
        blobs: repos.blobs,
        session: getSession,
        renewSession,
        now,
        classify: (subject) => adapter.classify?.(subject as never) ?? null,
        blobBudget: () =>
          config.crawl.pdfBudget === null
            ? null
            : Math.max(0, config.crawl.pdfBudget - blobsQueued),
      }),
    );

  // ── planner: seed the root, then keep leases honest ───────────────────────
  if (config.role === 'planner' || config.role === 'all') {
    const root = newPartitionNode({
      site,
      runId,
      range: config.crawl.root,
      now: now().toISOString(),
    });
    const existing = await repos.partitions.get(site, root.id);
    if (existing === null) await repos.partitions.save(root);
    const seeded = await queue.enqueue([
      {
        site,
        kind: 'search',
        key: `search:${root.id}`,
        payload: { partitionId: root.id, range: root.range, facets: {} },
      },
    ]);
    log(seeded > 0 ? `seeded the root partition ${root.id}` : 'root partition already seeded');

    const reaped = await queue.reapExpiredLeases(site);
    if (reaped > 0) log(`recovered ${String(reaped)} job(s) from workers that did not finish`);
  }

  // ── worker: the loop ──────────────────────────────────────────────────────
  let jobsRun = 0;
  let exitCode: number = ExitCode.OK;
  let canary: { id: string; message: string } | null = null;

  if (config.role === 'worker' || config.role === 'all') {
    const progressEvery = deps.progressEveryMs ?? 30_000;
    let lastProgress = Date.now();

    for (;;) {
      if (deps.signal?.aborted === true) {
        exitCode = ExitCode.INTERRUPTED;
        log('interrupted; the run is checkpointed and can be resumed');
        break;
      }
      if (config.crawl.maxJobs !== null && jobsRun >= config.crawl.maxJobs) {
        log(`stopping after ${String(jobsRun)} job(s), as --max-jobs asked`);
        break;
      }

      const job = await queue.lease(site, config.crawl.workerId, config.crawl.leaseMs);
      if (job === null) {
        // The planner may still be splitting partitions; only give up once nothing is left.
        const remaining = await queue.stats(site);
        if (remaining.pending === 0 && remaining.leased === 0) break;
        if (config.role === 'worker') {
          await sleep(config.crawl.idlePollMs, deps.signal);
          continue;
        }
        break;
      }

      const outcome = await pipeline.run(job);
      jobsRun++;
      if (job.kind === 'blob') blobsQueued++;

      if (outcome.kind === 'done') {
        await queue.complete(job.id);
      } else if (outcome.kind === 'retry') {
        // The delay is a placeholder until the retry policy lands in the next phase; the
        // decision of *whether* to retry is already the handler's, and the queue already knows
        // when to give up.
        const result = await queue.retry(job.id, 1_000, {
          failureClass: outcome.failureClass,
          error: outcome.error,
          httpStatus: outcome.httpStatus ?? null,
        });
        if (result === 'dead')
          log(`job ${job.key} exhausted its attempts (${outcome.failureClass})`);
      } else if (outcome.kind === 'dead') {
        await queue.dead(job.id, {
          failureClass: outcome.failureClass,
          error: outcome.error,
          httpStatus: outcome.httpStatus ?? null,
        });
      } else {
        // A canary tripped. Stop everything: the run's remaining work would produce data that
        // looks fine and is not.
        canary = { id: outcome.canaryId, message: outcome.error };
        await queue.retry(job.id, 0, {
          failureClass: 'FATAL_SITE_CHANGED',
          error: outcome.error,
        });
        exitCode = ExitCode.CANARY_FATAL;
        log(`canary ${outcome.canaryId} tripped: ${outcome.error}`);
        break;
      }

      if (Date.now() - lastProgress >= progressEvery) {
        lastProgress = Date.now();
        log(await progressLine(site, repos, queue));
      }
    }
  }

  const stats = await queue.stats(site);
  if (exitCode === ExitCode.OK && stats.dead > 0) exitCode = ExitCode.DEAD_JOBS_REMAIN;

  const cases = await repos.cases.countByState(site);
  const summary = {
    jobsRun,
    cases,
    queue: stats,
    gaps: gaps.length,
    canary,
  };

  // A run that stopped early is left unfinished on purpose, so the next start resumes it.
  const finished = exitCode !== ExitCode.INTERRUPTED && config.crawl.maxJobs === null;
  if (finished) await repos.runs.finish(runId, { exitCode, summary });

  log(await progressLine(site, repos, queue));
  log(
    `run ${runId} ${finished ? 'finished' : 'paused'} with exit code ${String(exitCode)} ` +
      `after ${String(jobsRun)} job(s)`,
  );

  return { runId, exitCode, jobsRun, gaps, canary, stats };
}

async function progressLine(site: string, repos: Repos, queue: JobQueue): Promise<string> {
  const [stats, cases, blobs] = await Promise.all([
    queue.stats(site),
    repos.cases.countByState(site),
    repos.blobs.countByState(site),
  ]);
  return (
    `jobs ${String(stats.done)} done · ${String(stats.pending)} pending · ${String(stats.dead)} dead` +
    ` · cases ${String((cases['LISTED'] ?? 0) + (cases['DETAILED'] ?? 0))}` +
    ` (${String(cases['DETAILED'] ?? 0)} detailed)` +
    ` · pdfs ${String(blobs['STORED'] ?? 0)}/${String((blobs['STORED'] ?? 0) + (blobs['PENDING'] ?? 0))}`
  );
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export { SiteChangedError };
