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
import { BlobHandler } from '../../core/engine/handlers/blob.js';
import { RetryPolicy } from '../../core/engine/retryPolicy.js';
import type { JobQueue } from '../../core/ports/jobQueue.js';
import type { Repos } from '../../core/ports/repos.js';
import type { SqlExecutor } from '../../core/ports/sql.js';
import type { HttpPort } from '../../core/ports/http.js';
import type { Throttle } from '../../core/ports/throttle.js';
import { BreakerAbort } from '../../core/ports/throttle.js';
import type { BlobStore } from '../../core/ports/blobStore.js';
import type { SiteAdapter, SiteSession } from '../../core/ports/siteAdapter.js';
import { SiteChangedError } from '../../core/ports/siteAdapter.js';
import { validatePdf } from '../../infra/blob/pdfValidate.js';
import { METRICS, MetricsRegistry } from '../../infra/metrics/registry.js';
import {
  ThrottledHttpClient,
  type ThrottledHttpOptions,
} from '../../infra/http/throttledHttpClient.js';
import type { Config } from '../config.js';

export interface CrawlDeps {
  config: Config;
  adapter: SiteAdapter;
  http: HttpPort;
  /**
   * The shared politeness budget. When present every request goes through it, which is the only
   * reason `--scale worker=3` does not mean three times the pressure on the court.
   */
  throttle?: Throttle;
  /** Tuning for the breaker that watches consecutive server failures. */
  breaker?: ThrottledHttpOptions;
  db: SqlExecutor;
  repos: Repos;
  queue: JobQueue;
  /** Absent in a planner-only process, which never downloads anything. */
  store?: BlobStore;
  /** Shared with the /metrics endpoint when one is running. */
  metrics?: MetricsRegistry;
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
  const { config, adapter, db, repos, queue } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const log =
    deps.log ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const site = adapter.descriptor.id;
  const http =
    deps.throttle === undefined
      ? deps.http
      : new ThrottledHttpClient(deps.http, deps.throttle, site, deps.breaker ?? {});

  await repos.site.ensure({
    id: site,
    country: adapter.descriptor.country,
    name: adapter.descriptor.name,
    baseUrl: adapter.descriptor.baseUrl,
    timezone: adapter.descriptor.timezone,
  });
  // Idempotent: the row keeps whatever the control law has learned about this site across runs,
  // so a restart does not hand back the concurrency a 429 took away an hour ago.
  await deps.throttle?.ensure(site, config.throttle);

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

  const metrics = deps.metrics ?? new MetricsRegistry();
  const gaps: { node: PartitionNode; evidence: GapEvidence }[] = [];

  /**
   * The run's PDF budget, held as remaining capacity rather than as a running total.
   *
   * Each detail job reserves what it needs and the rest of the run sees the reduced figure, so
   * `--pdf-budget 12` means twelve PDFs for the run and not twelve per case.
   */
  let blobBudgetLeft = config.crawl.pdfBudget;
  const reserveBlobs = (requested: number): number => {
    if (blobBudgetLeft === null) return requested;
    const granted = Math.max(0, Math.min(requested, blobBudgetLeft));
    blobBudgetLeft -= granted;
    return granted;
  };

  const pipeline = new Pipeline({
    classify: (subject) => adapter.classify?.(subject) ?? null,
  })
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
        reserveBlobs,
      }),
    );

  if (deps.store !== undefined) {
    pipeline.register(
      new BlobHandler({
        adapter,
        http,
        store: deps.store,
        blobs: repos.blobs,
        cases: repos.cases,
        session: getSession,
        renewSession,
        validate: validatePdf,
        classify: (subject) => adapter.classify?.(subject as never) ?? null,
        now,
      }),
    );
  }

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

    // Documents left over from an earlier run, whose budget ran out before they were fetched.
    //
    // Without this, raising `--pdf-budget` on a resumed run would change nothing: the cases are
    // already detailed, so no detail job runs, so no blob job is ever enqueued, and the pending
    // documents stay pending forever. `--pdf-budget all` is documented as the way to finish the
    // job, and this is what makes that true.
    if (deps.store !== undefined) {
      const pending: {
        site: string;
        kind: 'blob';
        key: string;
        payload: Record<string, unknown>;
      }[] = [];
      for await (const blob of repos.blobs.stream({ site, state: 'PENDING' })) {
        const granted = reserveBlobs(1);
        if (granted === 0) break;
        pending.push({
          site,
          kind: 'blob',
          key: `blob:${blob.key}`,
          payload: {
            request: {
              site: blob.site,
              key: blob.key,
              idOrigem: blob.idOrigem,
              idDoc: blob.idDoc,
              tipo: blob.tipo,
              url: blob.sourceUrl,
              needsSession: true,
            },
          },
        });
      }
      const requeued = await queue.enqueue(pending);
      if (requeued > 0) {
        log(`queued ${String(requeued)} document(s) left pending by an earlier run`);
      }
    }
  }

  // ── worker: the loop ──────────────────────────────────────────────────────
  let jobsRun = 0;
  let exitCode: number = ExitCode.OK;
  let canary: { id: string; message: string } | null = null;

  if (config.role === 'worker' || config.role === 'all') {
    const progressEvery = deps.progressEveryMs ?? 30_000;
    let lastProgress = Date.now();
    const retryPolicy = new RetryPolicy();
    /** The previous delay per job, so the decorrelated sequence grows instead of restarting. */
    const previousDelay = new Map<string, number>();
    const startedAt = new Map<string, number>();

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
        // Nothing claimable *right now* is not the same as nothing left to do: a job whose
        // retry is scheduled a few seconds out is still pending. Giving up here would end a run
        // over a single transient failure, which is exactly what a retry policy exists to
        // prevent. So the loop waits while work remains, in either role.
        const remaining = await queue.stats(site);
        if (remaining.pending === 0 && remaining.leased === 0) break;
        await sleep(config.crawl.idlePollMs, deps.signal);
        continue;
      }

      const jobStarted = Date.now();
      let outcome;
      try {
        outcome = await pipeline.run(job);
      } catch (error) {
        // The breaker has opened and re-opened until there was nothing left to conclude but that
        // the site is down or this client is blocked. The lease is left to expire rather than
        // marking the job failed: nothing is wrong with the job.
        if (!(error instanceof BreakerAbort)) throw error;
        exitCode = ExitCode.BREAKER_ABORTED;
        log(error.message);
        break;
      }
      jobsRun++;
      metrics.increment(METRICS.jobs, { kind: job.kind, outcome: outcome.kind });
      metrics.observe(METRICS.requestSeconds, Date.now() - jobStarted, { kind: job.kind });

      if (outcome.kind === 'done') {
        await queue.complete(job.id);
      } else if (outcome.kind === 'retry') {
        // Three separate decisions, none of them in the handler: the handler said *what kind* of
        // failure it was, the matrix says how long to wait, and the queue says when the attempts
        // are spent. Keeping them apart is what makes each one testable without the others.
        const firstSeen = startedAt.get(job.key) ?? Date.now();
        startedAt.set(job.key, firstSeen);
        const decision = retryPolicy.decide({
          failureClass: outcome.failureClass,
          attempt: job.attempts,
          previousDelayMs: previousDelay.get(job.key) ?? 0,
          elapsedMs: Date.now() - firstSeen,
        });

        if (decision.retry) {
          previousDelay.set(job.key, decision.delayMs);
          const result = await queue.retry(job.id, decision.delayMs, {
            failureClass: outcome.failureClass,
            error: outcome.error,
            httpStatus: outcome.httpStatus ?? null,
          });
          if (result === 'dead') {
            log(`job ${job.key} exhausted its attempts (${outcome.failureClass})`);
          }
        } else {
          // The matrix says this class is not worth another attempt, or the item has used its
          // time budget. Either way it goes to the dead letter queue with the reason attached.
          await queue.dead(job.id, {
            failureClass: outcome.failureClass,
            error: `${outcome.error} — ${decision.reason}`,
            httpStatus: outcome.httpStatus ?? null,
          });
          log(`job ${job.key} given up on: ${decision.reason}`);
        }
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

      if (outcome.kind === 'retry') {
        metrics.increment(METRICS.retries, { kind: job.kind, failure: outcome.failureClass });
      }

      if (Date.now() - lastProgress >= progressEvery) {
        lastProgress = Date.now();
        await publishGauges(site, repos, queue, metrics);
        log(await progressLine(site, repos, queue));
      }
    }
  }

  const stats = await queue.stats(site);
  if (exitCode === ExitCode.OK && stats.dead > 0) exitCode = ExitCode.DEAD_JOBS_REMAIN;

  await publishGauges(site, repos, queue, metrics);
  await repos.metrics.write(
    metrics.snapshot().map((sample) => ({
      runId,
      site,
      name: sample.name,
      labels: sample.labels,
      value: sample.value,
    })),
  );

  const cases = await repos.cases.countByState(site);
  const summary = {
    jobsRun,
    cases,
    queue: stats,
    gaps: gaps.length,
    canary,
  };

  // A run that stopped early is left unfinished on purpose, so the next start resumes it rather
  // than opening a second run over the same root. A tripped canary counts as stopping early:
  // the tree is half-built and the whole point is to come back to it once the site is understood.
  const finished =
    exitCode !== ExitCode.INTERRUPTED &&
    exitCode !== ExitCode.CANARY_FATAL &&
    exitCode !== ExitCode.BREAKER_ABORTED &&
    config.crawl.maxJobs === null;
  if (finished) await repos.runs.finish(runId, { exitCode, summary });

  log(await progressLine(site, repos, queue));
  log(
    `run ${runId} ${finished ? 'finished' : 'paused'} with exit code ${String(exitCode)} ` +
      `after ${String(jobsRun)} job(s)`,
  );

  return { runId, exitCode, jobsRun, gaps, canary, stats };
}

/** Mirrors the run's live counts into the registry, so `/metrics` reflects the database. */
async function publishGauges(
  site: string,
  repos: Repos,
  queue: JobQueue,
  metrics: MetricsRegistry,
): Promise<void> {
  const [stats, cases, blobs] = await Promise.all([
    queue.stats(site),
    repos.cases.countByState(site),
    repos.blobs.countByState(site),
  ]);
  metrics.gauge(METRICS.jobsPending, stats.pending, { site });
  metrics.gauge(METRICS.jobsDead, stats.dead, { site });
  for (const [state, n] of Object.entries(cases)) metrics.gauge(METRICS.cases, n, { site, state });
  for (const [state, n] of Object.entries(blobs)) metrics.gauge(METRICS.blobs, n, { site, state });
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
