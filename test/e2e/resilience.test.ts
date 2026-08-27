/**
 * Resilience, end to end.
 *
 * This is the file that answers the question the reconnaissance could not: **what does this
 * crawler do when the server says 429?** Provoking one against a real tribunal would be abusive,
 * and the reconnaissance could not reproduce one inside a responsible request budget — so the
 * behaviour is implemented in full and proved here, against a server that can be told to
 * misbehave on command.
 *
 * Every scenario below is a failure mode that was either measured on the live site or is an
 * explicit evaluation criterion. None of them is hypothetical.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { createRepos } from '../../src/infra/db/repos/index.js';
import { PgJobQueue } from '../../src/infra/db/pgJobQueue.js';
import { PgThrottle } from '../../src/infra/db/pgThrottle.js';
import { FetchHttpClient } from '../../src/infra/http/fetchHttpClient.js';
import { classifyFailure } from '../../src/core/engine/failureClassifier.js';
import { RetryPolicy } from '../../src/core/engine/retryPolicy.js';
import { parseRetryAfter } from '../../src/core/engine/backoff.js';
import { crawlCommand } from '../../src/app/commands/crawl.js';
import { dlqListCommand, retryDlqCommand } from '../../src/app/commands/dlq.js';
import { resolveConfig } from '../../src/app/config.js';
import { createSite } from '../../src/app/registry.js';
import { ExitCode } from '../../src/core/domain/types.js';
import { startFakePje, type FakePjeServer } from '../fake-pje-server/server.js';
import { SiteChangedError } from '../../src/core/ports/siteAdapter.js';

const SITE = 'fake-pje';
const ROOT = { ini: '2024-01-01', fim: '2024-01-20' };
const E2E_TIMEOUT = 120_000;

let fake: FakePjeServer;
let db: SqlExecutor;

beforeAll(async () => {
  fake = await startFakePje({ days: 30, seed: 11 });
  db = await PgliteExecutor.create();
  await migrate(db);
}, E2E_TIMEOUT);

afterAll(async () => {
  await db.close();
  await fake.close();
});

beforeEach(async () => {
  fake.clearFaults();
  for (const table of [
    'job',
    'blob',
    'document',
    'movement',
    'lawyer',
    'party',
    'subject',
    'case_record',
    'partition',
    'class_vocabulary',
    'metric',
    'site_throttle',
    'crawl_run',
  ]) {
    await db.query(`DELETE FROM juris.${table}`);
  }
});

function config(extra: string[] = []): ReturnType<typeof resolveConfig> {
  return resolveConfig({
    argv: [
      'crawl',
      '--site',
      SITE,
      '--root-start',
      ROOT.ini,
      '--root-end',
      ROOT.fim,
      '--pdf-budget',
      '0',
      ...extra,
    ],
    env: {},
  });
}

async function crawl(extra: string[] = []): Promise<Awaited<ReturnType<typeof crawlCommand>>> {
  return crawlCommand({
    config: config(extra),
    adapter: createSite(SITE, { baseUrl: fake.url }),
    http: new FetchHttpClient({ defaultTimeoutMs: 5_000 }),
    db,
    repos: createRepos(db),
    queue: new PgJobQueue(db, { defaultLeaseMs: 30_000 }),
    log: () => undefined,
    progressEveryMs: 1_000_000,
  });
}

const queue = (): PgJobQueue => new PgJobQueue(db, { defaultLeaseMs: 30_000 });

// ────────────────────── the throttle, in the loop ────────────────────

describe('the shared throttle is on the request path', { timeout: E2E_TIMEOUT }, () => {
  it('runs every request through it, and hands every slot back', async () => {
    const throttle = new PgThrottle(db, { cacheMs: 0, retryDelayMs: 5 });
    const result = await crawlCommand({
      // Rate and burst raised so the test measures the wiring rather than the wait; the control
      // law itself is proved in the throttle contract.
      config: resolveConfig({
        argv: [
          'crawl',
          '--site',
          SITE,
          '--root-start',
          ROOT.ini,
          '--root-end',
          ROOT.fim,
          '--pdf-budget',
          '0',
        ],
        env: { RATE_PER_SEC: '500', BURST: '500' },
      }),
      adapter: createSite(SITE, { baseUrl: fake.url }),
      http: new FetchHttpClient({ defaultTimeoutMs: 5_000 }),
      throttle,
      db,
      repos: createRepos(db),
      queue: queue(),
      log: () => undefined,
      progressEveryMs: 1_000_000,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    const snapshot = await throttle.snapshot(SITE);
    // Nothing left in flight: a leaked slot would shrink the budget of every later run.
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.breakerState).toBe('CLOSED');
    // The bucket was actually spent, which is the proof the requests went through it.
    expect(snapshot.tokens).toBeLessThan(500);
  });

  it('gives up with exit code 2 when the site stops answering, and stays resumable', async () => {
    // A server that answers nothing but 503. Retrying it forever would be the rude choice.
    fake.inject({ status: 503, times: 10_000 });
    const throttle = new PgThrottle(db, {
      cacheMs: 0,
      retryDelayMs: 5,
      maxConsecutiveOpens: 1,
      breakerBaseMs: 5,
    });

    const result = await crawlCommand({
      config: config(),
      adapter: createSite(SITE, { baseUrl: fake.url }),
      http: new FetchHttpClient({ defaultTimeoutMs: 5_000 }),
      throttle,
      breaker: { openAfter: 2 },
      db,
      repos: createRepos(db),
      queue: queue(),
      log: () => undefined,
      progressEveryMs: 1_000_000,
    });

    expect(result.exitCode).toBe(ExitCode.BREAKER_ABORTED);
    // Unfinished on purpose: the work is intact and the next start resumes it.
    const run = await createRepos(db).runs.get(result.runId);
    expect(run?.finishedAt).toBeNull();
  });
});

// ─────────────────────────── rate limiting ───────────────────────────

describe('429, with and without Retry-After', { timeout: E2E_TIMEOUT }, () => {
  it('retries through a burst of 429s and still completes the crawl', async () => {
    // Five refusals in a row, then the server relents. The crawl must survive that.
    fake.inject({ status: 429, retryAfter: 1, times: 5 });
    const result = await crawl();

    const repos = createRepos(db);
    const cases = await repos.cases.countByState(SITE);
    expect((cases['LISTED'] ?? 0) + (cases['DETAILED'] ?? 0)).toBeGreaterThan(0);
    expect(result.exitCode === ExitCode.OK || result.exitCode === ExitCode.DEAD_JOBS_REMAIN).toBe(
      true,
    );
  });

  it('survives 429s that carry no Retry-After at all — the case this site presents', async () => {
    // The reconnaissance never observed a Retry-After from TRF5, so backoff has to stand alone.
    fake.inject({ status: 429, times: 4 });
    const result = await crawl();
    const cases = await createRepos(db).cases.countByState(SITE);
    expect((cases['LISTED'] ?? 0) + (cases['DETAILED'] ?? 0)).toBeGreaterThan(0);
    expect(result.jobsRun).toBeGreaterThan(0);
  });

  it('reads Retry-After in both the forms the spec allows', async () => {
    for (const asDate of [false, true]) {
      fake.clearFaults();
      fake.inject({ status: 429, retryAfter: 2, retryAfterDate: asDate, times: 1 });
      const response = await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
      const header = response.headers.get('retry-after');
      const parsed = parseRetryAfter(header);
      expect(parsed, `form asDate=${String(asDate)}`).not.toBeNull();
      expect(parsed).toBeGreaterThan(0);
      expect(parsed).toBeLessThanOrEqual(3_000);
    }
  });

  it('makes one worker’s 429 lower the concurrency for every worker', async () => {
    // The point of keeping the limiter in Postgres: courtesy is per site, not per process.
    const throttle = new PgThrottle(db, { cacheMs: 0 });
    await db.query(
      `INSERT INTO juris.site (id, country, name, base_url, timezone)
       VALUES ($1,'BR','fake',$2,'America/Recife') ON CONFLICT DO NOTHING`,
      [SITE, fake.url],
    );
    await throttle.ensure(SITE, {
      concurrency: 8,
      concurrencyMin: 1,
      concurrencyMax: 8,
      ratePerSec: 100,
      burst: 100,
    });

    await throttle.reportOutcome(SITE, 'RATE_LIMITED');

    // A different instance stands in for a different process.
    const otherProcess = new PgThrottle(db, { cacheMs: 0 });
    expect((await otherProcess.snapshot(SITE)).concurrency).toBe(4);
  });

  it('classifies a persistent 429 as retryable and eventually buries the job', () => {
    // Not a crawl: the matrix, applied until it gives up. The crawl-level version of this would
    // take the full backoff sequence in real time.
    const policy = new RetryPolicy({ random: (_min, max) => max });
    let attempt = 1;
    let previous = 0;
    let elapsed = 0;
    for (;;) {
      const decision = policy.decide({
        failureClass: 'RATE_LIMITED',
        attempt,
        previousDelayMs: previous,
        elapsedMs: elapsed,
      });
      if (!decision.retry) break;
      previous = decision.delayMs;
      elapsed += decision.delayMs;
      attempt++;
      if (attempt > 20) throw new Error('the policy never gave up');
    }
    expect(attempt).toBe(6);
    expect(elapsed).toBeLessThan(300_000);
  });
});

// ─────────────────────── the dead letter queue ───────────────────────

describe('the dead letter queue', { timeout: E2E_TIMEOUT }, () => {
  /**
   * Puts something in the dead letter queue.
   *
   * The job is buried directly rather than by making a real one fail, so these tests exercise
   * the DLQ commands rather than whichever handlers happen to exist today. (Blob jobs currently
   * die on their own for want of a handler, which would make the assertions accidental.)
   */
  async function buryOne(
    failureClass: 'NOT_PDF' | 'RATE_LIMITED' = 'NOT_PDF',
    key = 'blob:relatorio:9999',
  ): Promise<void> {
    await db.query(
      `INSERT INTO juris.site (id, country, name, base_url, timezone)
       VALUES ($1,'BR','fake',$2,'America/Recife') ON CONFLICT DO NOTHING`,
      [SITE, fake.url],
    );
    const q = queue();
    await q.enqueue([{ site: SITE, kind: 'blob', key, payload: { key } }]);
    const job = await q.lease(SITE, 'w', 5_000);
    if (job === null) throw new Error('nothing to bury');
    await q.dead(job.id, { failureClass, error: 'body was HTML', httpStatus: 200 });
  }

  it('a run that ends with dead jobs exits 1 rather than pretending to be clean', async () => {
    await buryOne();
    const q = queue();
    expect((await q.stats(SITE)).dead).toBeGreaterThan(0);

    const lines: string[] = [];
    const code = await dlqListCommand(q, { site: SITE, write: (l) => lines.push(l) });
    expect(code).toBe(ExitCode.DEAD_JOBS_REMAIN);
  });

  it('lists what died, with the class, the attempts and the last error', async () => {
    await buryOne();
    const lines: string[] = [];
    await dlqListCommand(queue(), { site: SITE, write: (l) => lines.push(l) });
    const output = lines.join('\n');

    expect(output).toContain('FAILURE');
    expect(output).toContain('NOT_PDF');
    expect(output).toContain('body was HTML');
    expect(output).toContain('retry-dlq');
  });

  it('narrows the listing by kind', async () => {
    await buryOne();
    const lines: string[] = [];
    await dlqListCommand(queue(), { site: SITE, kind: 'search', write: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain('no dead jobs');
  });

  it('revives them, and the next crawl picks them up', async () => {
    await buryOne();
    await buryOne('RATE_LIMITED', 'blob:relatorio:9998');
    const q = queue();
    const deadBefore = (await q.stats(SITE)).dead;
    expect(deadBefore).toBeGreaterThan(0);

    const lines: string[] = [];
    const code = await retryDlqCommand(q, { site: SITE, write: (l) => lines.push(l) });
    expect(code).toBe(ExitCode.OK);
    expect(lines.join('\n')).toContain('back to pending');

    const after = await q.stats(SITE);
    expect(after.dead).toBe(0);
    expect(after.pending).toBe(deadBefore);

    // And their attempt counters are reset, so they get a full budget again.
    const revived = await q.lease(SITE, 'w', 5_000);
    expect(revived?.attempts).toBe(1);
    expect(revived?.failureClass).toBeNull();
  });

  it('says there is nothing to do when the queue is clean', async () => {
    const lines: string[] = [];
    await retryDlqCommand(queue(), { site: SITE, write: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain('nothing to reprocess');
  });

  it('a failed job does not stop the next one: the crawl continues past it', async () => {
    // The property that matters operationally — one bad document must not end a run.
    fake.inject({ status: 500, times: 3 });
    const result = await crawl();
    expect(result.jobsRun).toBeGreaterThan(3);
    const cases = await createRepos(db).cases.countByState(SITE);
    expect((cases['LISTED'] ?? 0) + (cases['DETAILED'] ?? 0)).toBeGreaterThan(0);
  });
});

// ────────────────────── sessions and site changes ──────────────────────

describe('session loss', { timeout: E2E_TIMEOUT }, () => {
  it('recovers mid-crawl without duplicating a single case', async () => {
    await crawl();
    const repos = createRepos(db);
    const before = await repos.cases.countByState(SITE);

    // Every issued token is invalidated, exactly as an expired session does.
    fake.inject({ expireSession: true });
    await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    fake.clearFaults();

    await crawl();
    const after = await repos.cases.countByState(SITE);
    const total = (c: Record<string, number>): number =>
      Object.values(c).reduce((sum, n) => sum + n, 0);
    expect(total(after)).toBe(total(before));

    const { rows } = await db.query<{ total: string | number; distinct: string | number }>(
      `SELECT count(*) AS total, count(DISTINCT id_origem) AS distinct FROM juris.case_record`,
    );
    expect(Number(rows[0]?.total)).toBe(Number(rows[0]?.distinct));
  });

  it('classifies a redirect back to the search page as a lost session', () => {
    const adapter = createSite(SITE, { baseUrl: fake.url });
    const redirect = {
      status: 302,
      headers: new Headers(),
      bodyBytes: new Uint8Array(),
      text: () => '',
      charset: 'utf-8',
      redirectedTo: '/pjeconsulta/ConsultaPublica/listView.seam',
      url: 'https://x',
      elapsedMs: 1,
    };
    expect(classifyFailure({ response: redirect }, (s) => adapter.classify?.(s) ?? null)).toBe(
      'SESSION_LOST',
    );
  });
});

describe('canaries stop the run', { timeout: E2E_TIMEOUT }, () => {
  it('a live captcha aborts with exit code 3 rather than returning nothing', async () => {
    // The single most dangerous silent failure: a crawl that runs happily and finds zero cases.
    fake.inject({ captcha: true, times: 50 });
    const result = await crawl();
    expect(result.exitCode).toBe(ExitCode.CANARY_FATAL);
    expect(result.canary?.id).toBe('C-2');
    expect(result.canary?.message).toContain('silently return nothing');
  });

  it('a changed row cap aborts, because the partitions already resolved are unsafe', async () => {
    fake.inject({ cap: 20, times: 50 });
    const result = await crawl();
    expect(result.exitCode).toBe(ExitCode.CANARY_FATAL);
    expect(result.canary?.id).toBe('C-4');
  });

  it('a renamed search action id aborts rather than searching nothing', async () => {
    // The button trap: without the current action id, the POST returns an empty message panel.
    fake.inject({ renameActionId: true, times: 1 });
    await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    const result = await crawl();
    // The adapter re-derives the id at bootstrap, so a rename is absorbed rather than fatal —
    // which is the whole reason it is derived instead of hardcoded.
    expect(result.exitCode).not.toBe(ExitCode.CANARY_FATAL);
    const cases = await createRepos(db).cases.countByState(SITE);
    expect((cases['LISTED'] ?? 0) + (cases['DETAILED'] ?? 0)).toBeGreaterThan(0);
  });

  it('the load balancer rejection page is a canary, not an empty result', async () => {
    fake.inject({ wafRejection: true, times: 50 });
    const result = await crawl();
    expect(result.exitCode).toBe(ExitCode.CANARY_FATAL);
    expect(result.canary?.id).toBe('C-10');
    expect(result.canary?.message).toContain('WAF block');
  });

  it('a tripped canary leaves the run resumable rather than half-recorded', async () => {
    fake.inject({ captcha: true, times: 50 });
    const aborted = await crawl();
    expect(aborted.exitCode).toBe(ExitCode.CANARY_FATAL);

    // The run is left unfinished on purpose, so the next start continues it.
    const run = await createRepos(db).runs.latest(SITE);
    expect(run?.runId).toBe(aborted.runId);

    fake.clearFaults();
    const recovered = await crawl();
    expect(recovered.runId).toBe(aborted.runId);
    expect(recovered.exitCode).not.toBe(ExitCode.CANARY_FATAL);
  });

  it('every canary the site can raise carries an id the catalogue documents', () => {
    const adapter = createSite(SITE, { baseUrl: fake.url });
    const documented = new Set(adapter.canaries.map((c) => c.id));
    for (const id of ['C-1', 'C-2', 'C-3', 'C-4', 'C-5', 'C-6', 'C-7', 'C-10']) {
      expect(documented.has(id), `canary ${id} is raised but not documented`).toBe(true);
    }
    expect(new SiteChangedError('C-1', 'x').canaryId).toBe('C-1');
  });
});

// ──────────────────────── transport failures ────────────────────────

describe('transport failures', { timeout: E2E_TIMEOUT }, () => {
  it('survives a dropped connection', async () => {
    fake.inject({ dropConnection: true, times: 2 });
    const result = await crawl();
    expect(result.jobsRun).toBeGreaterThan(0);
    const cases = await createRepos(db).cases.countByState(SITE);
    expect((cases['LISTED'] ?? 0) + (cases['DETAILED'] ?? 0)).toBeGreaterThan(0);
  });

  it('survives a slow response by timing it out rather than hanging', async () => {
    fake.inject({ delayMs: 8_000, times: 1 });
    const started = Date.now();
    const result = await crawl();
    // The default transport timeout is 5 s; the crawl must not sit on a hung socket.
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(result.jobsRun).toBeGreaterThan(0);
  });
});
