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
import { classifyFailure, type SiteClassifier } from './failureClassifier.js';
import { BreakerAbort } from '../ports/throttle.js';

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

export interface PipelineOptions {
  /**
   * The site's own classifier, consulted for exceptions the handlers let escape.
   *
   * Without it every unexpected error would be treated the same way, and the retry matrix is
   * only as good as the classification feeding it: a 429 that surfaces as an exception and gets
   * filed under `PARSE` is retried once instead of six times, which is the difference between
   * riding out a rate limit and giving up on the first one.
   */
  classify?: SiteClassifier;
}

export class Pipeline {
  private readonly handlers = new Map<JobKind, JobHandler>();
  private readonly classify: SiteClassifier | undefined;

  constructor(options: PipelineOptions = {}) {
    this.classify = options.classify;
  }

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

      // The breaker has given up on the site. Classifying this as a failure of the *job* would
      // schedule a retry — more requests at a server that has already stopped answering — so it
      // travels up to the loop untouched, which ends the run with its state intact.
      if (error instanceof BreakerAbort) throw error;

      // An exception still has a class. Classifying it — rather than filing everything under
      // `PARSE` — is what lets a rate limit that surfaced as a thrown error get the six patient
      // attempts its row in the matrix promises, instead of the single attempt a parse failure
      // deserves.
      const failureClass = classifyFailure({ error }, this.classify);
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return failureClass === 'FATAL_SITE_CHANGED'
        ? Outcome.fatal('unknown', message)
        : Outcome.retry(failureClass, message);
    }
  }
}
