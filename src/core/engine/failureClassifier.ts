/**
 * What kind of failure was that?
 *
 * Everything downstream — whether to retry, how long to wait, whether to lower the concurrency,
 * whether to stop the run — is decided from this one answer, so getting the classification right
 * matters more than any individual policy. The distinctions that earn their place are the ones
 * where two failures look identical and want opposite responses:
 *
 *   · A **429** and a **403** are both "the server said no". One wants patience; the other wants
 *     the run to stop, because three of them in a row is what a ban looks like.
 *   · A **302 to the search page** and a **302 to `errorUnexpected`** are both redirects away
 *     from a case. The first is a dead session and is worth renewing for; the second is a case
 *     the site cannot render, and retrying it six times spends a tribunal's capacity on nothing.
 *   · A **200 with an HTML body** where a PDF was promised is not a success. Neither is a **200
 *     carrying the load balancer's rejection page** — measured on the live site, and the reason
 *     status codes alone are not enough to classify by.
 *
 * The chain is generic first, then the site's own `classify`, which may override. A site knows
 * things about itself that no general rule can encode; a general rule covers what every site
 * shares.
 */
import type { FailureClass } from '../domain/types.js';
import { HttpTransportError, type HttpResponse } from '../ports/http.js';
import { SiteChangedError } from '../ports/siteAdapter.js';

export interface ClassifyInput {
  /** The response, when there was one. */
  response?: HttpResponse | undefined;
  /** The exception, when the request never became a response. */
  error?: unknown;
  /** What the caller was expecting back. */
  expect?: 'html' | 'pdf';
}

export type SiteClassifier = (subject: HttpResponse | Error) => FailureClass | null;

/** The load balancer's rejection page, returned with status 200. Measured, not hypothetical. */
const WAF_REJECTION = /Requisi[^<]{0,20}Rejeitada/i;

export function classifyFailure(input: ClassifyInput, siteClassify?: SiteClassifier): FailureClass {
  const generic = classifyGeneric(input);

  // The site gets the last word, because it knows its own redirects and error pages.
  const subject = input.response ?? input.error;
  if (siteClassify !== undefined && subject !== undefined) {
    const specific = siteClassify(subject as HttpResponse | Error);
    if (specific !== null) return specific;
  }
  return generic;
}

function classifyGeneric(input: ClassifyInput): FailureClass {
  const { response, error, expect } = input;

  if (error !== undefined) {
    if (error instanceof SiteChangedError) return 'FATAL_SITE_CHANGED';
    if (error instanceof HttpTransportError) return error.failureClass;
    if (error instanceof Error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'TIMEOUT';
      const code = (error as { cause?: { code?: unknown } }).cause?.code;
      if (typeof code === 'string' && NETWORK_CODES.has(code)) return 'NETWORK';
    }
    return 'PARSE';
  }

  if (response === undefined) return 'PARSE';

  if (response.status === 429) return 'RATE_LIMITED';
  if (response.status >= 500) return 'SERVER_ERROR';
  if (response.status === 408) return 'TIMEOUT';

  // A redirect is not a failure in itself — the caller decides. Reaching here with one means
  // nobody wanted it, which for this site means the session is gone.
  if (response.status >= 300 && response.status < 400) return 'SESSION_LOST';

  if (response.status >= 400) return 'CLIENT_ERROR';

  // Status 200 and still wrong. Two ways that happens here, both measured.
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('html') || contentType.includes('text')) {
    if (WAF_REJECTION.test(response.text())) return 'RATE_LIMITED';
  }
  if (expect === 'pdf' && !contentType.includes('pdf')) return 'NOT_PDF';

  return 'PARSE';
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

/** Classes that feed the circuit breaker: they say something about the *server*, not the item. */
export const BREAKER_CLASSES: ReadonlySet<FailureClass> = new Set([
  'RATE_LIMITED',
  'SERVER_ERROR',
  'NETWORK',
  'TIMEOUT',
]);

/** Classes that mean "stop the run". */
export function isFatal(failureClass: FailureClass): boolean {
  return failureClass === 'FATAL_SITE_CHANGED';
}
