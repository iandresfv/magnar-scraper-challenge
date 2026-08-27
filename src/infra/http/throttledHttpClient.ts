/**
 * Politeness, applied where every request must pass.
 *
 * The throttle, the AIMD control law and the circuit breaker all live in one Postgres row, and
 * this is what connects them to the traffic. It is a decorator rather than a change to the
 * transport because the two concerns are genuinely separate — `FetchHttpClient` knows about
 * encodings and cookies, this knows about how hard a public court server may be pushed — and
 * because the fake-site tests want the transport without the row.
 *
 * Wrapping the transport, rather than calling the throttle from each handler, is what makes the
 * guarantee hold: there is no way to make a request that skips it, including the ones a future
 * handler adds.
 */
import type { CookieJarPort, HttpPort, HttpRequest, HttpResponse } from '../../core/ports/http.js';
import { HttpTransportError } from '../../core/ports/http.js';
import type { Throttle } from '../../core/ports/throttle.js';
import type { FailureClass } from '../../core/domain/types.js';
import { BREAKER_CLASSES } from '../../core/engine/failureClassifier.js';
import { parseRetryAfter } from '../../core/engine/backoff.js';

export interface ThrottledHttpOptions {
  /**
   * Consecutive server-side failures before the breaker opens.
   *
   * Consecutive, not a ratio: a court that answers every other request is having a bad day, one
   * that answers none of the last five is not answering.
   */
  openAfter?: number;
  now?: () => number;
}

export class ThrottledHttpClient implements HttpPort {
  private consecutiveFailures = 0;
  private readonly openAfter: number;
  private readonly now: () => number;

  constructor(
    private readonly inner: HttpPort,
    private readonly throttle: Throttle,
    private readonly site: string,
    options: ThrottledHttpOptions = {},
  ) {
    this.openAfter = options.openAfter ?? 5;
    this.now = options.now ?? ((): number => Date.now());
  }

  newJar(): CookieJarPort {
    return this.inner.newJar();
  }

  async send(req: HttpRequest, jar: CookieJarPort): Promise<HttpResponse> {
    // Asked before acquiring, so an open breaker whose time has passed recovers on the next
    // request instead of waiting for something else to notice.
    await this.throttle.halfOpenIfDue(this.site);

    const lease = await this.throttle.acquire(this.site, req.signal);
    try {
      const response = await this.inner.send(req, jar);
      await this.report(outcomeOf(response), retryAfterOf(response, this.now()));
      return response;
    } catch (error) {
      if (error instanceof HttpTransportError) await this.report(error.failureClass, null);
      throw error;
    } finally {
      await lease.release();
    }
  }

  /**
   * Feeds one request's outcome to the control law, and decides whether it was the last straw.
   *
   * The counter is per process on purpose: the shared row already carries the consequences of
   * everyone's failures, and having each worker also count everyone else's would open the
   * breaker N times faster on a fleet of N workers.
   */
  private async report(outcome: FailureClass | 'OK', retryAfterMs: number | null): Promise<void> {
    await this.throttle.reportOutcome(this.site, outcome, { retryAfterMs });

    if (outcome === 'OK' || !BREAKER_CLASSES.has(outcome)) {
      this.consecutiveFailures = 0;
      return;
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.openAfter) {
      this.consecutiveFailures = 0;
      // Throws `BreakerAbort` when reopening has stopped helping; the pipeline lets it through.
      await this.throttle.openBreaker(
        this.site,
        `${String(this.openAfter)} consecutive ${outcome} responses`,
      );
    }
  }
}

/** What one response says about the *server*. A 404 says nothing; a 503 says plenty. */
function outcomeOf(response: HttpResponse): FailureClass | 'OK' {
  if (response.status === 429) return 'RATE_LIMITED';
  if (response.status >= 500) return 'SERVER_ERROR';
  return 'OK';
}

function retryAfterOf(response: HttpResponse, now: number): number | null {
  const header = response.headers.get('retry-after');
  return header === null ? null : parseRetryAfter(header, now);
}
