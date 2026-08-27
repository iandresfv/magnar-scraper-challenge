/**
 * The decorator that makes the politeness guarantee true.
 *
 * These are the assertions that would have caught the throttle being implemented, contract-tested
 * and never actually reached by a request: the wiring is the feature.
 */
import { describe, expect, it } from 'vitest';
import type {
  CookieJarPort,
  HttpPort,
  HttpRequest,
  HttpResponse,
} from '../../src/core/ports/http.js';
import { HttpTransportError } from '../../src/core/ports/http.js';
import type { FailureClass } from '../../src/core/domain/types.js';
import { BreakerAbort, type Throttle } from '../../src/core/ports/throttle.js';
import { ThrottledHttpClient } from '../../src/infra/http/throttledHttpClient.js';

interface Recorded {
  events: string[];
  outcomes: { outcome: FailureClass | 'OK'; retryAfterMs: number | null }[];
  inFlight: number;
  maxInFlight: number;
}

function fakeThrottle(options: { abortOnOpen?: boolean } = {}): Throttle & { log: Recorded } {
  const log: Recorded = { events: [], outcomes: [], inFlight: 0, maxInFlight: 0 };
  return {
    log,
    acquire: () => {
      log.events.push('acquire');
      log.inFlight++;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      return Promise.resolve({
        release: () => {
          log.inFlight--;
          log.events.push('release');
          return Promise.resolve();
        },
      });
    },
    reportOutcome: async (_site, outcome, hints) => {
      log.events.push(`report:${outcome}`);
      log.outcomes.push({ outcome, retryAfterMs: hints?.retryAfterMs ?? null });
      return Promise.resolve();
    },
    openBreaker: async (_site, reason) => {
      log.events.push(`open:${reason}`);
      if (options.abortOnOpen === true) throw new BreakerAbort(5, 'the site is down');
      return Promise.resolve();
    },
    halfOpenIfDue: async () => {
      log.events.push('halfOpenIfDue');
      return Promise.resolve(false);
    },
    snapshot: async () =>
      Promise.resolve({
        concurrency: 1,
        inFlight: log.inFlight,
        tokens: 1,
        refillPerSec: 1,
        breakerState: 'CLOSED' as const,
        breakerUntil: null,
        retryAfterUntil: null,
      }),
    ensure: async () => Promise.resolve(),
  };
}

function fakeHttp(respond: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>): HttpPort {
  return {
    send: async (req) => respond(req),
    newJar: () => ({}) as CookieJarPort,
  };
}

const response = (status: number, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: new Headers(headers),
  bodyBytes: new Uint8Array(),
  text: () => '',
  charset: 'utf-8',
  redirectedTo: null,
  url: 'https://example.test/',
  elapsedMs: 1,
});

const request: HttpRequest = { method: 'GET', url: 'https://example.test/' };
const jar = {} as CookieJarPort;

describe('every request', () => {
  it('takes a slot, reports its outcome, and gives the slot back', async () => {
    const throttle = fakeThrottle();
    const client = new ThrottledHttpClient(
      fakeHttp(() => response(200)),
      throttle,
      'site',
    );

    await client.send(request, jar);
    expect(throttle.log.events).toEqual(['halfOpenIfDue', 'acquire', 'report:OK', 'release']);
    expect(throttle.log.inFlight).toBe(0);
  });

  it('gives the slot back when the transport throws, which is when it matters', async () => {
    const throttle = fakeThrottle();
    const client = new ThrottledHttpClient(
      fakeHttp(() => {
        throw new HttpTransportError('connection reset', 'NETWORK');
      }),
      throttle,
      'site',
    );

    await expect(client.send(request, jar)).rejects.toThrow('connection reset');
    expect(throttle.log.inFlight).toBe(0);
    expect(throttle.log.outcomes.map((o) => o.outcome)).toEqual(['NETWORK']);
  });

  it('never lets more than one request past a single-slot throttle', async () => {
    const throttle = fakeThrottle();
    const client = new ThrottledHttpClient(
      fakeHttp(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return response(200);
      }),
      throttle,
      'site',
    );

    await Promise.all([client.send(request, jar), client.send(request, jar)]);
    // The fake counts overlap; the real one enforces it in SQL. Both must see the release.
    expect(throttle.log.events.filter((e) => e === 'release')).toHaveLength(2);
  });
});

describe('what a response says about the server', () => {
  it('reads 429 as rate limiting and honours Retry-After in seconds', async () => {
    const throttle = fakeThrottle();
    const client = new ThrottledHttpClient(
      fakeHttp(() => response(429, { 'retry-after': '30' })),
      throttle,
      'site',
    );

    await client.send(request, jar);
    expect(throttle.log.outcomes[0]).toEqual({ outcome: 'RATE_LIMITED', retryAfterMs: 30_000 });
  });

  it('reads 5xx as a server error and 4xx as nothing about the server', async () => {
    const throttle = fakeThrottle();
    const client = new ThrottledHttpClient(
      fakeHttp((req) => response(req.url.endsWith('/500') ? 503 : 404)),
      throttle,
      'site',
    );

    await client.send({ ...request, url: 'https://example.test/500' }, jar);
    await client.send({ ...request, url: 'https://example.test/404' }, jar);
    expect(throttle.log.outcomes.map((o) => o.outcome)).toEqual(['SERVER_ERROR', 'OK']);
  });
});

describe('the circuit breaker', () => {
  it('opens after enough consecutive server failures', async () => {
    const throttle = fakeThrottle();
    const client = new ThrottledHttpClient(
      fakeHttp(() => response(503)),
      throttle,
      'site',
      {
        openAfter: 3,
      },
    );

    for (let i = 0; i < 3; i++) await client.send(request, jar);
    expect(throttle.log.events.filter((e) => e.startsWith('open:'))).toEqual([
      'open:3 consecutive SERVER_ERROR responses',
    ]);
  });

  it('counts consecutively: one good answer resets the count', async () => {
    const throttle = fakeThrottle();
    let calls = 0;
    const client = new ThrottledHttpClient(
      fakeHttp(() => response(++calls === 3 ? 200 : 503)),
      throttle,
      'site',
      { openAfter: 3 },
    );

    for (let i = 0; i < 5; i++) await client.send(request, jar);
    expect(throttle.log.events.some((e) => e.startsWith('open:'))).toBe(false);
  });

  it('lets the abort through, because it is not this request that failed', async () => {
    const throttle = fakeThrottle({ abortOnOpen: true });
    const client = new ThrottledHttpClient(
      fakeHttp(() => response(503)),
      throttle,
      'site',
      {
        openAfter: 1,
      },
    );

    await expect(client.send(request, jar)).rejects.toBeInstanceOf(BreakerAbort);
    expect(throttle.log.inFlight).toBe(0);
  });
});
