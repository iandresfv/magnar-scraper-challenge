/**
 * The retry matrix: one row per failure class, and nothing else decides.
 *
 * Written as data rather than as branching code, because the question a reader has is "what
 * happens on a 429?" and the answer should be one line to look at rather than a control flow to
 * follow. It is also the table the README publishes, so having it in one place keeps the
 * documentation and the behaviour from drifting apart.
 *
 * Two constraints beyond the per-class limits:
 *
 * **A per-item time budget.** Six attempts with a sixty-second cap is five minutes of a worker's
 * life spent on one PDF. The budget stops an item from monopolising a worker no matter how the
 * individual delays fall out.
 *
 * **`Retry-After` wins.** When the server states a wait, honouring it is both correct and
 * cheaper than guessing — and the guess would be the same size anyway.
 */
import type { FailureClass } from '../domain/types.js';
import type { Random } from '../ports/clock.js';
import { decorrelatedJitter, honourRetryAfter, type BackoffOptions } from './backoff.js';

export interface RetryRule {
  /** Zero means the class is not retried at all. */
  maxAttempts: number;
  backoff: BackoffOptions;
  /** Why this class is treated the way it is. Printed by `--help` and by the README. */
  rationale: string;
}

export const RETRY_MATRIX: Readonly<Record<FailureClass, RetryRule>> = {
  RATE_LIMITED: {
    maxAttempts: 6,
    backoff: { baseMs: 1_000, capMs: 60_000 },
    rationale:
      'the server asked for patience; honour Retry-After when present, back off with jitter ' +
      'when not, and lower the shared concurrency either way',
  },
  SERVER_ERROR: {
    maxAttempts: 4,
    backoff: { baseMs: 2_000, capMs: 30_000 },
    rationale: 'a 5xx is usually transient, but a run of them means the site is unwell',
  },
  TIMEOUT: {
    maxAttempts: 3,
    backoff: { baseMs: 2_000, capMs: 30_000 },
    rationale: 'the request may simply have been slow; three tries, then leave it for the DLQ',
  },
  NETWORK: {
    maxAttempts: 3,
    backoff: { baseMs: 2_000, capMs: 30_000 },
    rationale: 'a reset connection is worth retrying; a broken route is not worth six',
  },
  SESSION_LOST: {
    maxAttempts: 2,
    backoff: { baseMs: 500, capMs: 5_000 },
    rationale:
      'the fix is a new session and a fresh token, not waiting — so retry quickly and only ' +
      'twice, because a third failure means something other than the session is wrong',
  },
  NOT_PDF: {
    maxAttempts: 2,
    backoff: { baseMs: 1_000, capMs: 10_000 },
    rationale:
      'HTML where a PDF was promised is what a dead session looks like at this endpoint; one ' +
      'retry after a renewal is worth it, more is not',
  },
  PDF_TRUNCATED: {
    maxAttempts: 2,
    backoff: { baseMs: 1_000, capMs: 10_000 },
    rationale: 'a cut transfer is worth one more attempt; a consistently short file is not',
  },
  CLIENT_ERROR: {
    maxAttempts: 0,
    backoff: { baseMs: 0, capMs: 0 },
    rationale:
      'a 4xx will not become a 2xx by being asked again. Includes the cases this site cannot ' +
      'render, which redirect to errorUnexpected and would otherwise burn six requests each',
  },
  PARSE: {
    maxAttempts: 1,
    backoff: { baseMs: 1_000, capMs: 5_000 },
    rationale:
      'one retry, because a partial response parses badly and a complete one may not; repeated ' +
      'parse failures are a site change and are escalated rather than retried',
  },
  FATAL_SITE_CHANGED: {
    maxAttempts: 0,
    backoff: { baseMs: 0, capMs: 0 },
    rationale: 'the run stops. Continuing would produce data that looks fine and is not',
  },
  BUDGET_EXHAUSTED: {
    maxAttempts: 0,
    backoff: { baseMs: 0, capMs: 0 },
    rationale: 'not a failure: the work stays pending for the next run',
  },
};

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
}

export interface RetryContext {
  failureClass: FailureClass;
  /** Attempts made so far, including the one that just failed. */
  attempt: number;
  /** The previous delay, for the decorrelated sequence. */
  previousDelayMs: number;
  /** Milliseconds already spent on this item across all its attempts. */
  elapsedMs: number;
  retryAfterMs?: number | null;
}

export interface RetryPolicyOptions {
  /** Total time one item may consume before it is given up on, however it fails. */
  itemBudgetMs?: number;
  random?: Random;
}

export class RetryPolicy {
  private readonly itemBudgetMs: number;
  private readonly random: Random | undefined;

  constructor(options: RetryPolicyOptions = {}) {
    this.itemBudgetMs = options.itemBudgetMs ?? 300_000;
    this.random = options.random;
  }

  decide(ctx: RetryContext): RetryDecision {
    const rule = RETRY_MATRIX[ctx.failureClass];

    if (rule.maxAttempts === 0) {
      return { retry: false, delayMs: 0, reason: `${ctx.failureClass} is not retried` };
    }
    if (ctx.attempt >= rule.maxAttempts) {
      return {
        retry: false,
        delayMs: 0,
        reason: `${ctx.failureClass} exhausted its ${String(rule.maxAttempts)} attempts`,
      };
    }
    if (ctx.elapsedMs >= this.itemBudgetMs) {
      return {
        retry: false,
        delayMs: 0,
        reason: `this item has already taken ${String(Math.round(ctx.elapsedMs / 1000))} s, over its budget`,
      };
    }

    if (ctx.retryAfterMs !== null && ctx.retryAfterMs !== undefined) {
      const delayMs = honourRetryAfter(
        ctx.retryAfterMs,
        { capMs: rule.backoff.capMs },
        this.random ?? undefined,
      );
      return { retry: true, delayMs, reason: 'honouring the server Retry-After header' };
    }

    const delayMs = decorrelatedJitter(ctx.previousDelayMs, rule.backoff, this.random ?? undefined);
    return {
      retry: true,
      delayMs,
      reason: `${ctx.failureClass} attempt ${String(ctx.attempt + 1)}/${String(rule.maxAttempts)}`,
    };
  }

  /** The matrix, for the README and for `--help`. */
  static describe(): { failureClass: FailureClass; rule: RetryRule }[] {
    return (Object.keys(RETRY_MATRIX) as FailureClass[]).map((failureClass) => ({
      failureClass,
      rule: RETRY_MATRIX[failureClass],
    }));
  }
}
