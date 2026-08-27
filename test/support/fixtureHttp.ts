/**
 * An `HttpPort` that answers from the committed fixtures.
 *
 * This is how the TRF5 adapter is exercised end to end without a single request leaving the
 * machine. It is deliberately a real implementation of the port rather than a mocking-library
 * stub: the adapter's own code path runs unchanged, including the cookie jar it asks the port
 * for and the redirect handling it does itself.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CookieJarPort,
  HttpPort,
  HttpRequest,
  HttpResponse,
} from '../../src/core/ports/http.js';
import { decodeBody } from '../../src/infra/http/encoding.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'sites',
  'br-trf5',
  'fixtures',
);

export const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(FIXTURES, name)));

/** A jar that records what it was told, with no path logic: routing is not under test here. */
export class RecordingJar implements CookieJarPort {
  readonly cookies = new Map<string, string>();

  setFromResponse(_url: string, setCookieHeaders: readonly string[]): Promise<void> {
    for (const raw of setCookieHeaders) {
      const [pair = ''] = raw.split(';', 1);
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return Promise.resolve();
  }

  headerFor(): Promise<string> {
    return Promise.resolve([...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
  }

  serialize(): Promise<string> {
    return Promise.resolve(JSON.stringify([...this.cookies]));
  }
}

export interface StubbedResponse {
  status?: number;
  body?: Uint8Array;
  headers?: Record<string, string>;
  location?: string;
}

export type Responder = (req: HttpRequest) => StubbedResponse;

export interface FixtureHttpOptions {
  /** Matched in order; the first whose pattern matches the URL answers. */
  routes: { match: RegExp | ((req: HttpRequest) => boolean); respond: Responder }[];
}

export class FixtureHttp implements HttpPort {
  readonly sent: HttpRequest[] = [];

  constructor(private readonly options: FixtureHttpOptions) {}

  newJar(): CookieJarPort {
    return new RecordingJar();
  }

  send(req: HttpRequest, jar: CookieJarPort): Promise<HttpResponse> {
    this.sent.push(req);

    const route = this.options.routes.find(({ match }) =>
      typeof match === 'function' ? match(req) : match.test(req.url),
    );
    if (route === undefined) {
      return Promise.resolve(
        buildResponse(req, { status: 404, body: new Uint8Array(), headers: {} }),
      );
    }

    const stub = route.respond(req);
    const setCookie = stub.headers?.['set-cookie'];
    if (setCookie !== undefined) void jar.setFromResponse(req.url, [setCookie]);
    return Promise.resolve(buildResponse(req, stub));
  }

  /** The request bodies sent so far, decoded as latin1 — the charset the search form uses. */
  bodies(): string[] {
    return this.sent
      .filter((r) => r.body !== undefined)
      .map((r) => Buffer.from(r.body ?? new Uint8Array()).toString('latin1'));
  }
}

function buildResponse(req: HttpRequest, stub: StubbedResponse): HttpResponse {
  const bodyBytes = stub.body ?? new Uint8Array();
  const headers = new Headers(stub.headers ?? {});
  if (stub.location !== undefined) headers.set('location', stub.location);
  if (!headers.has('content-type')) {
    headers.set(
      'content-type',
      req.expect === 'pdf' ? 'application/pdf' : 'text/html;charset=ISO-8859-1',
    );
  }

  let decoded: { text: string; charset: string } | null = null;
  return {
    status: stub.status ?? 200,
    headers,
    bodyBytes,
    text: () => {
      decoded ??= decodeBody(bodyBytes, headers);
      return decoded.text;
    },
    get charset() {
      decoded ??= decodeBody(bodyBytes, headers);
      return decoded.charset;
    },
    redirectedTo: stub.location ?? null,
    url: req.url,
    elapsedMs: 1,
  };
}

/**
 * The empty result, captured from the live site during the phase-0 spike: 4 846 bytes, the grid
 * re-rendered, and `<span class="text-muted">resultados encontrados</span>` with no count.
 */
const EMPTY_SEARCH_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?><html><head>
<meta name="Ajax-Response" content="true"/>
<meta name="Ajax-Update-Ids" content="fPP:processosGridPanel"/>
</head><body><div id="fPP:processosGridPanel">
<table id="fPP:processosTable"><tbody></tbody>
<tfoot><tr><td><div><div><span class="text-muted">resultados encontrados</span></div></div></td></tr></tfoot>
</table></div></body></html>`;

/** The routes that make the adapter behave as it does against the live site. */
export function trf5FixtureRoutes(): FixtureHttpOptions['routes'] {
  return [
    {
      match: /\/ConsultaPublica\/listView\.seam$/,
      respond: () => ({
        body: fixtureBytes('01-listview-form.html'),
        headers: {
          'content-type': 'text/html;charset=ISO-8859-1',
          'set-cookie': 'JSESSIONID=fixture.tt-consulta-229; Path=/pjeconsulta',
        },
      }),
    },
    {
      // A range with no data. The real site answers with the grid re-rendered and a footer that
      // carries no number at all — the marker is an absence, not a message — so the fixture
      // transport has to model that rather than always replaying the populated page.
      match: (req) =>
        req.method === 'POST' && Buffer.from(req.body ?? new Uint8Array()).includes('1901'),
      respond: () => ({
        body: new Uint8Array(Buffer.from(EMPTY_SEARCH_RESPONSE, 'utf8')),
        headers: { 'content-type': 'text/xml;charset=UTF-8' },
      }),
    },
    {
      match: (req) => req.method === 'POST',
      respond: () => ({
        body: fixtureBytes('02-search-response-30-truncado.html'),
        headers: { 'content-type': 'text/xml;charset=UTF-8' },
      }),
    },
    {
      match: /DetalheProcessoConsultaPublica\/listView\.seam\?ca=/,
      respond: () => ({
        body: fixtureBytes('03-detalhe-processo-16730.html'),
        headers: { 'content-type': 'text/html;charset=ISO-8859-1' },
      }),
    },
    {
      match: /reportPDF\.seam/,
      respond: () => ({
        // The real endpoint hands the file over through one redirect to the docstore.
        status: 302,
        location: 'https://pjett.trf5.jus.br/pjeconsulta/seam/docstore/document.seam?docId=1&cid=1',
      }),
    },
    {
      match: /reportReciboPDF\.seam/,
      respond: () => ({
        body: fixtureBytes('05-reportReciboPDF-7222997.pdf'),
        headers: { 'content-type': 'application/pdf' },
      }),
    },
    {
      match: /docstore\/document\.seam/,
      respond: () => ({
        body: fixtureBytes('04-reportPDF-16730.pdf'),
        headers: { 'content-type': 'application/pdf' },
      }),
    },
  ];
}
