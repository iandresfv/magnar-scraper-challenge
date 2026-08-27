/**
 * The work queue, which is a Postgres table.
 *
 * Why a table and not Redis or a broker: the queue has to be transactional **with the data**.
 * When a detail job finishes it must insert the case and enqueue its PDFs atomically — if those
 * are two systems, there is a window where one succeeded and the other did not, and the usual
 * cure is an outbox, which is a table. So: start with the table.
 *
 * What that buys, for free: resumption after a crash (leases expire), horizontal scaling
 * (`FOR UPDATE SKIP LOCKED` means N identical workers never take the same row), and a dead
 * letter queue that is just `status = 'dead'` and can be inspected with SQL.
 */
import type { FailureClass } from '../domain/types.js';
import type { SqlSession } from './sql.js';

export type JobKind = 'search' | 'detail' | 'blob' | 'verify';
export type JobStatus = 'pending' | 'leased' | 'done' | 'dead';

export interface Job {
  id: string;
  site: string;
  kind: JobKind;
  /** Idempotency key: `search:<partitionId>` | `detail:<idOrigem>` | `blob:<blobKey>`. */
  key: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  leasedBy: string | null;
  leaseUntil: string | null;
  failureClass: FailureClass | null;
  lastError: string | null;
  httpStatus: number | null;
}

export interface EnqueueRequest {
  site: string;
  kind: JobKind;
  key: string;
  payload: Record<string, unknown>;
  /** Lower runs first. search 10 < detail 50 < blob 90: finish a leaf before starting another. */
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date;
}

export interface QueueStats {
  pending: number;
  leased: number;
  done: number;
  dead: number;
  byKind: Record<string, { pending: number; dead: number }>;
}

export interface JobQueue {
  /** Insert-if-absent on `(site, key)`. Re-enqueuing known work is a no-op, not a duplicate. */
  enqueue(requests: readonly EnqueueRequest[], tx?: SqlSession): Promise<number>;
  /** Atomically claims one runnable job with a lease. `null` when there is nothing to do. */
  lease(site: string, workerId: string, leaseMs: number): Promise<Job | null>;
  complete(jobId: string, tx?: SqlSession): Promise<void>;
  /** Puts the job back with a delay. Crosses `maxAttempts` and it goes to `dead` instead. */
  retry(jobId: string, delayMs: number, failure: JobFailure): Promise<'retried' | 'dead'>;
  dead(jobId: string, failure: JobFailure): Promise<void>;
  /** Releases leases whose holder died. Run by the planner every 30 s. */
  reapExpiredLeases(site: string): Promise<number>;
  /** The DLQ command: `dead` back to `pending`. */
  revive(site: string, filter: { kind?: JobKind; limit?: number }): Promise<number>;
  listDead(site: string, filter: { kind?: JobKind; limit?: number }): Promise<Job[]>;
  stats(site: string): Promise<QueueStats>;
}

export interface JobFailure {
  failureClass: FailureClass;
  error: string;
  httpStatus?: number | null;
}
