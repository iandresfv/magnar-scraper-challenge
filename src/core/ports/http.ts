/**
 * The transport port.
 *
 * The contract that matters is what this does **not** do: `send` never retries and never
 * follows a redirect. Both are decisions the engine has to make with context. A 302 to
 * `listView.seam` is not a redirect to chase, it is the site telling us the session died; a
 * transport that followed it would turn a diagnosable failure into an empty parse.
 */
import type { FailureClass } from '../domain/types.js';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  timeoutMs?: number;
  /** What the caller expects back. Only used to classify a mismatch, never to parse. */
  expect?: 'html' | 'pdf';
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  bodyBytes: Uint8Array;
  /** Decoded by detection (header, then document declaration, then strict UTF-8, then latin1). */
  text(): string;
  charset: string;
  /** `Location` when the status is a redirect. The transport does not follow it. */
  redirectedTo: string | null;
  url: string;
  elapsedMs: number;
}

export interface CookieJarPort {
  setFromResponse(url: string, setCookieHeaders: readonly string[]): Promise<void>;
  headerFor(url: string): Promise<string>;
  /** Serialised jar, so a session can be handed to another worker or logged for debugging. */
  serialize(): Promise<string>;
}

export interface HttpPort {
  send(req: HttpRequest, jar: CookieJarPort): Promise<HttpResponse>;

  /**
   * A fresh, empty cookie jar.
   *
   * It lives on the transport port because creating one is a transport concern, and because a
   * site adapter needs one at bootstrap but must not reach into `infra/` to get it — the
   * hexagonal test says so, and it is right: which jar implementation is in use is not something
   * a court should know.
   */
  newJar(): CookieJarPort;
}

/** Thrown by the transport for anything that never became a response. */
export class HttpTransportError extends Error {
  constructor(
    message: string,
    readonly failureClass: Extract<FailureClass, 'NETWORK' | 'TIMEOUT'>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpTransportError';
  }
}
