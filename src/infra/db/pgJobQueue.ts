/**
 * The work queue, as a Postgres table.
 *
 * The claim query is the whole design in five lines:
 *
 * ```sql
 * UPDATE juris.job SET status='leased', leased_by=…, lease_until=now()+interval '…'
 * WHERE id = (SELECT id FROM juris.job WHERE … ORDER BY … FOR UPDATE SKIP LOCKED LIMIT 1)
 * RETURNING *
 * ```
 *
 * `FOR UPDATE SKIP LOCKED` is what makes N identical worker processes safe: each one locks the
 * row it is about to claim, and any other worker that reaches the same row *steps over it*
 * instead of blocking. No coordinator, no partitioning of work between workers, no duplicates.
 * The subselect matters too — locking inside it keeps the lock to one row rather than to every
 * row the ordering had to consider.
 *
 * The **lease** is what makes a crash survivable. A claimed job is not removed from the queue,
 * it is stamped with an expiry; a worker killed mid-job leaves a row whose lease runs out, and
 * the planner hands it to somebody else. That is the entire resume story, and it costs one
 * `UPDATE … WHERE lease_until < now()`.
 *
 * The **dead letter queue** is `status = 'dead'`. Not a second table, not a second system — the
 * same rows, in a state that can be listed with SQL and moved back with one statement.
 */
import type {
  EnqueueRequest,
  Job,
  JobFailure,
  JobKind,
  JobQueue,
  JobStatus,
  QueueStats,
} from '../../core/ports/jobQueue.js';
import type { FailureClass } from '../../core/domain/types.js';
import type { SqlExecutor, SqlRow, SqlSession } from '../../core/ports/sql.js';
import {
  readNumber,
  readString,
  readStringOrNull,
  readTimestampOrNull,
} from './repos/rowMapping.js';

/** Lower runs first, so a leaf is finished before another is started. */
export const PRIORITY: Record<JobKind, number> = {
  search: 10,
  detail: 50,
  blob: 90,
  verify: 99,
};

export interface PgJobQueueOptions {
  /** Default lease length. Long enough for the slowest job, short enough to recover promptly. */
  defaultLeaseMs?: number;
}

export class PgJobQueue implements JobQueue {
  private readonly defaultLeaseMs: number;

  constructor(
    private readonly db: SqlExecutor,
    options: PgJobQueueOptions = {},
  ) {
    this.defaultLeaseMs = options.defaultLeaseMs ?? 90_000;
  }

  /**
   * Insert-if-absent on `(site, key)`.
   *
   * Re-enqueuing known work is a no-op rather than a duplicate, which is what lets the planner
   * re-seed freely after a restart and lets a detail handler enqueue its PDFs without first
   * checking whether a previous run already did.
   */
  async enqueue(requests: readonly EnqueueRequest[], tx?: SqlSession): Promise<number> {
    if (requests.length === 0) return 0;
    const session = tx ?? this.db;
    let inserted = 0;

    for (const request of requests) {
      const { rows } = await session.query(
        `INSERT INTO juris.job (site, kind, key, payload, priority, max_attempts, run_after)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()))
         ON CONFLICT (site, key) DO NOTHING
         RETURNING id`,
        [
          request.site,
          request.kind,
          request.key,
          JSON.stringify(request.payload),
          request.priority ?? PRIORITY[request.kind],
          request.maxAttempts ?? 6,
          request.runAfter?.toISOString() ?? null,
        ],
      );
      if (rows.length > 0) inserted++;
    }
    return inserted;
  }

  async lease(site: string, workerId: string, leaseMs?: number): Promise<Job | null> {
    const ms = leaseMs ?? this.defaultLeaseMs;
    const { rows } = await this.db.query(
      `UPDATE juris.job j
         SET status = 'leased',
             leased_by = $2,
             lease_until = now() + make_interval(secs => $3),
             attempts = attempts + 1,
             updated_at = now()
       WHERE j.id = (
         SELECT id FROM juris.job
          WHERE site = $1 AND status = 'pending' AND run_after <= now()
          ORDER BY priority, run_after, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING *`,
      [site, workerId, ms / 1000],
    );
    const row = rows[0];
    return row === undefined ? null : hydrate(row);
  }

  async complete(jobId: string, tx?: SqlSession): Promise<void> {
    // Completion often shares a transaction with the data the job produced, so that a crash
    // between "the case is stored" and "the job is done" cannot lose either.
    await (tx ?? this.db).query(
      `UPDATE juris.job
         SET status='done', leased_by=NULL, lease_until=NULL, updated_at=now()
       WHERE id = $1`,
      [jobId],
    );
  }

  async retry(jobId: string, delayMs: number, failure: JobFailure): Promise<'retried' | 'dead'> {
    // One statement decides between retrying and giving up, so two workers cannot both conclude
    // "this was the last attempt".
    const { rows } = await this.db.query<{ status: string }>(
      `UPDATE juris.job
         SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
             run_after = now() + make_interval(secs => $2),
             leased_by = NULL,
             lease_until = NULL,
             failure_class = $3,
             last_error = $4,
             http_status = $5,
             updated_at = now()
       WHERE id = $1
       RETURNING status`,
      [
        jobId,
        delayMs / 1000,
        failure.failureClass,
        failure.error.slice(0, 2_000),
        failure.httpStatus ?? null,
      ],
    );
    return rows[0]?.status === 'dead' ? 'dead' : 'retried';
  }

  async dead(jobId: string, failure: JobFailure): Promise<void> {
    await this.db.query(
      `UPDATE juris.job
         SET status='dead', leased_by=NULL, lease_until=NULL,
             failure_class=$2, last_error=$3, http_status=$4, updated_at=now()
       WHERE id = $1`,
      [jobId, failure.failureClass, failure.error.slice(0, 2_000), failure.httpStatus ?? null],
    );
  }

  /**
   * Releases jobs whose holder died. Run by the planner every thirty seconds.
   *
   * `attempts` is deliberately **not** decremented: a job that repeatedly kills its worker is a
   * job that should eventually reach the dead letter queue rather than loop forever.
   */
  async reapExpiredLeases(site: string): Promise<number> {
    const { rows } = await this.db.query(
      `UPDATE juris.job
         SET status='pending', leased_by=NULL, lease_until=NULL, updated_at=now()
       WHERE site=$1 AND status='leased' AND lease_until < now()
       RETURNING id`,
      [site],
    );
    return rows.length;
  }

  /** The reprocessing command: `dead` back to `pending`, with its attempt count reset. */
  async revive(site: string, filter: { kind?: JobKind; limit?: number }): Promise<number> {
    const { rows } = await this.db.query(
      `UPDATE juris.job
         SET status='pending', attempts=0, run_after=now(),
             failure_class=NULL, last_error=NULL, updated_at=now()
       WHERE id IN (
         SELECT id FROM juris.job
          WHERE site=$1 AND status='dead' AND ($2::text IS NULL OR kind=$2)
          ORDER BY id
          LIMIT $3
       )
       RETURNING id`,
      [site, filter.kind ?? null, filter.limit ?? 10_000],
    );
    return rows.length;
  }

  async listDead(site: string, filter: { kind?: JobKind; limit?: number }): Promise<Job[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM juris.job
        WHERE site=$1 AND status='dead' AND ($2::text IS NULL OR kind=$2)
        ORDER BY updated_at DESC
        LIMIT $3`,
      [site, filter.kind ?? null, filter.limit ?? 100],
    );
    return rows.map(hydrate);
  }

  async stats(site: string): Promise<QueueStats> {
    const { rows } = await this.db.query<{ kind: string; status: string; n: string | number }>(
      `SELECT kind, status, count(*) AS n FROM juris.job WHERE site=$1 GROUP BY kind, status`,
      [site],
    );

    const stats: QueueStats = { pending: 0, leased: 0, done: 0, dead: 0, byKind: {} };
    for (const row of rows) {
      const n = Number(row.n);
      if (row.status === 'pending') stats.pending += n;
      else if (row.status === 'leased') stats.leased += n;
      else if (row.status === 'done') stats.done += n;
      else if (row.status === 'dead') stats.dead += n;

      const byKind = (stats.byKind[row.kind] ??= { pending: 0, dead: 0 });
      if (row.status === 'pending') byKind.pending += n;
      if (row.status === 'dead') byKind.dead += n;
    }
    return stats;
  }
}

function hydrate(row: SqlRow): Job {
  return {
    id: readString(row, 'id'),
    site: readString(row, 'site'),
    kind: readString(row, 'kind') as JobKind,
    key: readString(row, 'key'),
    payload: parsePayload(row['payload']),
    status: readString(row, 'status') as JobStatus,
    priority: readNumber(row, 'priority'),
    attempts: readNumber(row, 'attempts'),
    maxAttempts: readNumber(row, 'max_attempts'),
    runAfter: readTimestampOrNull(row, 'run_after') ?? '',
    leasedBy: readStringOrNull(row, 'leased_by'),
    leaseUntil: readTimestampOrNull(row, 'lease_until'),
    failureClass: readStringOrNull(row, 'failure_class') as FailureClass | null,
    lastError: readStringOrNull(row, 'last_error'),
    httpStatus: row['http_status'] === null ? null : readNumber(row, 'http_status'),
  };
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value as Record<string, unknown>;
}
