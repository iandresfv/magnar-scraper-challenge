/**
 * The failure matrix and the backoff, tested with an injected clock and an injected random
 * source — so the delays are exact numbers rather than "roughly a second", and the suite costs
 * microseconds rather than minutes.
 */
import { describe, expect, it } from 'vitest';
import {
  backoffSequence,
  decorrelatedJitter,
  honourRetryAfter,
  parseRetryAfter,
} from '../../src/core/engine/backoff.js';
import { RetryPolicy, RETRY_MATRIX } from '../../src/core/engine/retryPolicy.js';
import {
  BREAKER_CLASSES,
  classifyFailure,
  isFatal,
} from '../../src/core/engine/failureClassifier.js';
import { HttpTransportError, type HttpResponse } from '../../src/core/ports/http.js';
import { SiteChangedError } from '../../src/core/ports/siteAdapter.js';
import type { FailureClass } from '../../src/core/domain/types.js';

/** Always the top of the range, so a jittered value is still exactly predictable. */
const maxRandom = (_min: number, max: number): number => max;
const minRandom = (min: number): number => min;

function response(over: {
  status?: number;
  contentType?: string;
  body?: string;
  location?: string;
}): HttpResponse {
  const headers = new Headers({ 'content-type': over.contentType ?? 'text/html' });
  if (over.location !== undefined) headers.set('location', over.location);
  return {
    status: over.status ?? 200,
    headers,
    bodyBytes: new Uint8Array(),
    text: () => over.body ?? '',
    charset: 'utf-8',
    redirectedTo: over.location ?? null,
    url: 'https://example/x',
    elapsedMs: 1,
  };
}

describe('decorrelated jitter', () => {
  const options = { baseMs: 1_000, capMs: 60_000 };

  it('starts at the base, deterministically', () => {
    expect(decorrelatedJitter(0, options, maxRandom)).toBe(1_000);
  });

  it('grows its upper bound by the factor each time', () => {
    expect(decorrelatedJitter(1_000, options, maxRandom)).toBe(3_000);
    expect(decorrelatedJitter(3_000, options, maxRandom)).toBe(9_000);
    expect(decorrelatedJitter(9_000, options, maxRandom)).toBe(27_000);
  });

  it('never returns less than the base, however unlucky the draw', () => {
    for (const previous of [0, 500, 1_000, 10_000, 50_000]) {
      expect(decorrelatedJitter(previous, options, minRandom)).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('never exceeds the cap, however many failures precede it', () => {
    let previous = 0;
    for (let i = 0; i < 20; i++) {
      previous = decorrelatedJitter(previous, options, maxRandom);
      expect(previous).toBeLessThanOrEqual(60_000);
    }
    expect(previous).toBe(60_000);
  });

  it('produces a spread rather than a schedule — the point of jitter', () => {
    // Two workers rate-limited at the same instant must not come back at the same instant.
    const draws = new Set(
      Array.from({ length: 200 }, () =>
        decorrelatedJitter(5_000, { baseMs: 1_000, capMs: 60_000 }),
      ),
    );
    expect(draws.size).toBeGreaterThan(50);
  });

  it('stays inside [base, previous x 3] for every draw', () => {
    for (let i = 0; i < 500; i++) {
      const delay = decorrelatedJitter(4_000, { baseMs: 1_000, capMs: 60_000 });
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(12_000);
    }
  });

  it('produces the sequence the README publishes', () => {
    expect(backoffSequence(5, { baseMs: 1_000, capMs: 60_000 }, maxRandom)).toEqual([
      1_000, 3_000, 9_000, 27_000, 60_000,
    ]);
  });
});

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('3')).toBe(3_000);
    expect(parseRetryAfter(' 120 ')).toBe(120_000);
  });

  it('reads an HTTP-date, which the spec also allows', () => {
    const now = Date.parse('2026-08-27T12:00:00Z');
    expect(parseRetryAfter('Thu, 27 Aug 2026 12:00:30 GMT', now)).toBe(30_000);
  });

  it('treats a date in the past as no wait at all, rather than a negative one', () => {
    const now = Date.parse('2026-08-27T12:00:00Z');
    expect(parseRetryAfter('Thu, 27 Aug 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns null when there is no usable header — the case this site actually presents', () => {
    // The reconnaissance never observed a Retry-After, so backoff must stand on its own.
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('caps and jitters what the server asked for', () => {
    // Ten workers told "three seconds" would otherwise return in perfect formation.
    expect(honourRetryAfter(3_000, { capMs: 60_000, jitterMs: 500 }, maxRandom)).toBe(3_500);
    expect(honourRetryAfter(3_600_000, { capMs: 60_000 }, maxRandom)).toBe(60_000);
  });
});

describe('the failure matrix', () => {
  const policy = new RetryPolicy({ random: maxRandom });
  const base = { attempt: 1, previousDelayMs: 0, elapsedMs: 0 };

  it('retries a 429 and honours the header when there is one', () => {
    const decision = policy.decide({ ...base, failureClass: 'RATE_LIMITED', retryAfterMs: 3_000 });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(3_500);
    expect(decision.reason).toContain('Retry-After');
  });

  it('retries a 429 with backoff when there is no header', () => {
    const decision = policy.decide({ ...base, failureClass: 'RATE_LIMITED' });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(1_000);
  });

  it('never retries a client error, because a 4xx will not become a 2xx', () => {
    const decision = policy.decide({ ...base, failureClass: 'CLIENT_ERROR' });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain('not retried');
  });

  it('never retries a site change: the run stops instead', () => {
    expect(policy.decide({ ...base, failureClass: 'FATAL_SITE_CHANGED' }).retry).toBe(false);
    expect(isFatal('FATAL_SITE_CHANGED')).toBe(true);
    expect(isFatal('RATE_LIMITED')).toBe(false);
  });

  it('stops once a class has used its attempts', () => {
    const exhausted = policy.decide({ ...base, failureClass: 'TIMEOUT', attempt: 3 });
    expect(exhausted.retry).toBe(false);
    expect(exhausted.reason).toContain('exhausted');
    expect(RETRY_MATRIX.TIMEOUT.maxAttempts).toBe(3);
  });

  it('stops once an item has consumed its time budget, however it was failing', () => {
    // Six attempts at a sixty-second cap is five minutes of a worker spent on one PDF.
    const decision = policy.decide({
      ...base,
      failureClass: 'RATE_LIMITED',
      elapsedMs: 400_000,
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain('budget');
  });

  it('retries a lost session quickly, because waiting is not the fix', () => {
    const decision = policy.decide({ ...base, failureClass: 'SESSION_LOST' });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(500);
    expect(RETRY_MATRIX.SESSION_LOST.maxAttempts).toBe(2);
  });

  it('gives every class a rationale, because the matrix is documentation as much as code', () => {
    for (const { failureClass, rule } of RetryPolicy.describe()) {
      expect(rule.rationale.length, `${failureClass} has no rationale`).toBeGreaterThan(30);
      expect(rule.maxAttempts).toBeGreaterThanOrEqual(0);
    }
  });

  it('follows a full 429 sequence to exhaustion within its budget', () => {
    let previous = 0;
    let elapsed = 0;
    const delays: number[] = [];
    for (let attempt = 1; ; attempt++) {
      const decision = policy.decide({
        failureClass: 'RATE_LIMITED',
        attempt,
        previousDelayMs: previous,
        elapsedMs: elapsed,
      });
      if (!decision.retry) break;
      previous = decision.delayMs;
      elapsed += decision.delayMs;
      delays.push(decision.delayMs);
    }
    expect(delays).toEqual([1_000, 3_000, 9_000, 27_000, 60_000]);
    expect(elapsed).toBeLessThan(300_000);
  });
});

describe('classification', () => {
  it.each<[string, Parameters<typeof classifyFailure>[0], FailureClass]>([
    ['a 429', { response: response({ status: 429 }) }, 'RATE_LIMITED'],
    ['a 503', { response: response({ status: 503 }) }, 'SERVER_ERROR'],
    ['a 500', { response: response({ status: 500 }) }, 'SERVER_ERROR'],
    ['a 408', { response: response({ status: 408 }) }, 'TIMEOUT'],
    ['a 404', { response: response({ status: 404 }) }, 'CLIENT_ERROR'],
    ['a 403', { response: response({ status: 403 }) }, 'CLIENT_ERROR'],
    [
      'an unwanted redirect',
      { response: response({ status: 302, location: '/x' }) },
      'SESSION_LOST',
    ],
  ])('classifies %s', (_label, input, expected) => {
    expect(classifyFailure(input)).toBe(expected);
  });

  it('classifies a transport timeout', () => {
    expect(classifyFailure({ error: new HttpTransportError('slow', 'TIMEOUT') })).toBe('TIMEOUT');
  });

  it('classifies a reset connection as network', () => {
    const error = new Error('fetch failed');
    (error as { cause?: unknown }).cause = { code: 'ECONNRESET' };
    expect(classifyFailure({ error })).toBe('NETWORK');
  });

  it('classifies a tripped canary as fatal', () => {
    expect(classifyFailure({ error: new SiteChangedError('C-2', 'captcha is live') })).toBe(
      'FATAL_SITE_CHANGED',
    );
  });

  it('classifies HTML where a PDF was promised, at status 200', () => {
    // The measured symptom of a dead session at the PDF endpoint.
    expect(
      classifyFailure({
        response: response({ status: 200, contentType: 'text/html', body: '<html>login</html>' }),
        expect: 'pdf',
      }),
    ).toBe('NOT_PDF');
  });

  it('classifies the load balancer rejection page as rate limiting, despite its 200', () => {
    // Measured on the live site: status 200, a plausible body, and nothing else to go on.
    expect(
      classifyFailure({
        response: response({
          status: 200,
          contentType: 'text/html;charset=ISO-8859-1',
          body: '<title>Requisição - Rejeitada</title>',
        }),
      }),
    ).toBe('RATE_LIMITED');
  });

  it('lets the site have the last word', () => {
    // A site knows its own error pages; the generic rule cannot.
    const siteSays: FailureClass = 'CLIENT_ERROR';
    expect(
      classifyFailure(
        { response: response({ status: 302, location: '/errorUnexpected.seam' }) },
        () => siteSays,
      ),
    ).toBe('CLIENT_ERROR');
  });

  it('falls back to the generic answer when the site has no opinion', () => {
    expect(classifyFailure({ response: response({ status: 429 }) }, () => null)).toBe(
      'RATE_LIMITED',
    );
  });

  it('knows which classes say something about the server rather than the item', () => {
    // Only these feed the circuit breaker; a 404 says nothing about the site's health.
    expect([...BREAKER_CLASSES].sort()).toEqual([
      'NETWORK',
      'RATE_LIMITED',
      'SERVER_ERROR',
      'TIMEOUT',
    ]);
    expect(BREAKER_CLASSES.has('CLIENT_ERROR')).toBe(false);
    expect(BREAKER_CLASSES.has('NOT_PDF')).toBe(false);
  });
});
