/**
 * The transport, over Node's built-in `fetch` (undici).
 *
 * The contract is defined as much by what this refuses to do as by what it does:
 *
 *   · **It never retries.** `withRetry` is the only place that decides to try again, because
 *     that decision needs the failure class, the attempt count, the per-item budget and the
 *     shared throttle — none of which belong in a transport.
 *   · **It never follows a redirect.** A 302 here is information, not an obstacle: to
 *     `listView.seam` it means the session died, to `errorUnexpected.seam` it means the case
 *     cannot be rendered, and to `docstore/document.seam` it is the normal path to a PDF. A
 *     transport that followed all three would erase the difference and hand the engine an HTML
 *     page where it expected bytes.
 *   · **It never sets an empty `Cookie` header.** Measured against the live site: doing so makes
 *     the F5 answer `200 OK` with a "Requisição - Rejeitada" page. See `docs/spike-fase0.md` §2.
 *
 * Everything it does do — decoding, cookie handling, timeouts, elapsed time — is the part that
 * would otherwise be duplicated in every adapter.
 */
import type { CookieJarPort, HttpPort, HttpRequest, HttpResponse } from '../../core/ports/http.js';
import { HttpTransportError } from '../../core/ports/http.js';
import { CookieJar } from './cookieJar.js';
import { decodeBody } from './encoding.js';

/**
 * Identifiable and honest. A court that wants to know who is crawling it should be able to
 * find out; hiding behind a plain browser string while ignoring the robots of politeness is
 * exactly the behaviour that gets scrapers blocked, and deserves to.
 */
export const DEFAULT_USER_AGENT =
  'juris-scraper/1.0 (+https://github.com/iandresfv/magnar-scraper-challenge) ' +
  'Mozilla/5.0 (compatible)';

export interface FetchHttpClientOptions {
  userAgent?: string;
  acceptLanguage?: string;
  defaultTimeoutMs?: number;
  /** Injected in tests to assert elapsed time without waiting. */
  now?: () => number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class FetchHttpClient implements HttpPort {
  private readonly userAgent: string;
  private readonly acceptLanguage: string;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: FetchHttpClientOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.acceptLanguage = options.acceptLanguage ?? 'pt-BR,pt;q=0.9';
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  newJar(): CookieJarPort {
    return CookieJar.create();
  }

  async send(req: HttpRequest, jar: CookieJarPort): Promise<HttpResponse> {
    const headers = new Headers({
      'User-Agent': this.userAgent,
      'Accept-Language': this.acceptLanguage,
      Accept:
        req.expect === 'pdf'
          ? 'application/pdf,*/*;q=0.8'
          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
    for (const [key, value] of Object.entries(req.headers ?? {})) headers.set(key, value);

    const cookie = await jar.headerFor(req.url);
    if (cookie !== '') headers.set('Cookie', cookie);

    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      req.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, req.signal]);

    const started = this.now();
    let response: Response;
    try {
      response = await fetch(req.url, {
        method: req.method,
        headers,
        ...(req.body === undefined ? {} : { body: req.body }),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      throw classifyTransportFailure(error, req, timeoutMs);
    }

    const bodyBytes = new Uint8Array(await response.arrayBuffer());
    const elapsedMs = this.now() - started;

    // Cookies are absorbed even from a redirect: the 302 that leads to the docstore is where
    // the conversation id is handed over.
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length > 0) await jar.setFromResponse(req.url, setCookie);

    const location = response.headers.get('location');
    const redirectedTo =
      REDIRECT_STATUSES.has(response.status) && location !== null
        ? new URL(location, req.url).toString()
        : null;

    // Decoding a 20 MB PDF as text would be pure waste, and `text()` is not called for blobs.
    let decoded: { text: string; charset: string } | null = null;
    const text = (): string => {
      decoded ??= decodeBody(bodyBytes, response.headers);
      return decoded.text;
    };

    return {
      status: response.status,
      headers: response.headers,
      bodyBytes,
      text,
      get charset(): string {
        decoded ??= decodeBody(bodyBytes, response.headers);
        return decoded.charset;
      },
      redirectedTo,
      url: req.url,
      elapsedMs,
    };
  }
}

/**
 * Turn a thrown fetch failure into one of the two classes a transport can legitimately produce.
 * Everything else — status codes, wrong content types, dead sessions — is the classifier's job,
 * because it needs the response body to decide.
 */
function classifyTransportFailure(
  error: unknown,
  req: HttpRequest,
  timeoutMs: number,
): HttpTransportError {
  const name = error instanceof Error ? error.name : '';
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  const codeText = typeof code === 'string' ? code : '';

  if (name === 'TimeoutError' || name === 'AbortError' || codeText === 'UND_ERR_HEADERS_TIMEOUT') {
    return new HttpTransportError(
      `${req.method} ${req.url} timed out after ${String(timeoutMs)} ms`,
      'TIMEOUT',
      { cause: error },
    );
  }

  const detail =
    codeText !== '' ? codeText : error instanceof Error ? error.message : String(error);
  return new HttpTransportError(`${req.method} ${req.url} failed: ${detail}`, 'NETWORK', {
    cause: error,
  });
}
