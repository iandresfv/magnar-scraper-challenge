/**
 * The pipeline: what a worker does with a job, without knowing which job it is.
 *
 * A `JobHandler` takes a job and returns one of three outcomes — `Done`, `Retry`, or `Dead`.
 * That is the entire vocabulary. Handlers do not sleep, do not decide backoff, do not touch the
 * queue, and do not know how many attempts have happened: they say *what kind of thing went
 * wrong*, and the pipeline turns that into a delay, a retry, or a burial, using the policy.
 *
 * Keeping those apart is what makes the retry behaviour testable without a network and the
 * handlers readable without a policy in your head.
 *
 * The one rule handlers must respect is transactional: whatever a job produces, and the jobs it
 * spawns, land in the **same transaction**. A detail job that stored a case but crashed before
 * enqueuing its PDFs would leave a case whose documents nobody will ever fetch, and no amount of
 * retrying would notice, because the case is already there.
 */
import type { FailureClass } from '../domain/types.js';
import type { Job, JobKind } from '../ports/jobQueue.js';

export type HandlerOutcome =
  | { kind: 'done'; detail?: string }
  /** Try again later. The pipeline decides how much later. */
  | { kind: 'retry'; failureClass: FailureClass; error: string; httpStatus?: number | null }
  /** Do not try again: retrying cannot help. */
  | { kind: 'dead'; failureClass: FailureClass; error: string; httpStatus?: number | null }
  /** Stop the whole run. The site changed underneath us. */
  | { kind: 'fatal'; failureClass: 'FATAL_SITE_CHANGED'; error: string; canaryId: string };

export const Outcome = {
  done: (detail?: string): HandlerOutcome =>
    detail === undefined ? { kind: 'done' } : { kind: 'done', detail },
  retry: (
    failureClass: FailureClass,
    error: string,
    httpStatus?: number | null,
  ): HandlerOutcome => ({
    kind: 'retry',
    failureClass,
    error,
    httpStatus: httpStatus ?? null,
  }),
  dead: (
    failureClass: FailureClass,
    error: string,
    httpStatus?: number | null,
  ): HandlerOutcome => ({
    kind: 'dead',
    failureClass,
    error,
    httpStatus: httpStatus ?? null,
  }),
  fatal: (canaryId: string, error: string): HandlerOutcome => ({
    kind: 'fatal',
    failureClass: 'FATAL_SITE_CHANGED',
    error,
    canaryId,
  }),
} as const;

export interface JobHandler {
  readonly kind: JobKind;
  handle(job: Job): Promise<HandlerOutcome>;
}

/** Raised by a handler to stop the run. Distinguished from an ordinary failure by the pipeline. */
export class FatalSiteChange extends Error {
  constructor(
    readonly canaryId: string,
    message: string,
  ) {
    super(message);
    this.name = 'FatalSiteChange';
  }
}

export class Pipeline {
  private readonly handlers = new Map<JobKind, JobHandler>();

  register(handler: JobHandler): this {
    this.handlers.set(handler.kind, handler);
    return this;
  }

  has(kind: JobKind): boolean {
    return this.handlers.has(kind);
  }

  /**
   * Runs one job.
   *
   * A handler that throws is not a crash: an unexpected exception is classified like any other
   * failure so that one malformed page cannot take a worker down. Only `FatalSiteChange` is
   * allowed through, because that is the case where continuing would produce quietly wrong data.
   */
  async run(job: Job): Promise<HandlerOutcome> {
    const handler = this.handlers.get(job.kind);
    if (handler === undefined) {
      return Outcome.dead('CLIENT_ERROR', `no handler registered for job kind "${job.kind}"`);
    }

    try {
      return await handler.handle(job);
    } catch (error) {
      if (error instanceof FatalSiteChange) {
        return Outcome.fatal(error.canaryId, error.message);
      }
      // Unknown exceptions are retried once or twice rather than buried immediately: a transient
      // parse failure on a partial response is far more common than a permanently broken page.
      return Outcome.retry(
        'PARSE',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    }
  }
}
