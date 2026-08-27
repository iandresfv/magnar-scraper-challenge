/**
 * Transport tests against a real `node:http` server on an ephemeral port.
 *
 * A mocking library would be faster to write and would prove less: the properties under test
 * (cookies applied by path, a redirect *not* followed, an empty `Cookie` header never sent, a
 * timeout that actually aborts) are all about what goes over the socket. Only a real socket can
 * show that.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CookieJar } from '../../src/infra/http/cookieJar.js';
import { FetchHttpClient } from '../../src/infra/http/fetchHttpClient.js';
import { HttpTransportError } from '../../src/core/ports/http.js';
import { detectMojibake } from '../../src/core/domain/text.js';

interface Received {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  /** `true` when the request carried a Cookie header at all, empty or not. */
  hadCookieHeader: boolean;
  body: string;
}

let server: Server;
let base: string;
const received: Received[] = [];

function handler(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    received.push({
      url: req.url ?? '',
      method: req.method ?? '',
      headers: req.headers,
      hadCookieHeader: 'cookie' in req.headers,
      body: Buffer.concat(chunks).toString('latin1'),
    });

    const path = (req.url ?? '').split('?')[0];
    switch (path) {
      case '/set-cookies': {
        // Two cookies scoped to different paths, as the real site does.
        res.setHeader('Set-Cookie', [
          'JSESSIONID=abc.node-1; Path=/scoped',
          'ROUTER_ID=deadbeef; Path=/; SameSite=None',
        ]);
        res.writeHead(200, { 'content-type': 'text/html;charset=UTF-8' });
        res.end('ok');
        return;
      }
      case '/scoped':
      case '/elsewhere': {
        res.writeHead(200, { 'content-type': 'text/plain;charset=UTF-8' });
        res.end(req.headers.cookie ?? '(no cookie header)');
        return;
      }
      case '/waf': {
        // The measured behaviour of the F5: status 200 with a rejection page.
        res.writeHead(200, { 'content-type': 'text/html;charset=ISO-8859-1' });
        res.end(Buffer.from('<title>Requisição - Rejeitada</title>', 'latin1'));
        return;
      }
      case '/redirect': {
        res.writeHead(302, { location: '/target' });
        res.end();
        return;
      }
      case '/target': {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('followed');
        return;
      }
      case '/utf8': {
        // Declares latin1, sends UTF-8: the site's actual trap.
        res.writeHead(200, { 'content-type': 'text/html;charset=ISO-8859-1' });
        res.end(Buffer.from('APELAÇÃO CÍVEL', 'utf8'));
        return;
      }
      case '/latin1': {
        res.writeHead(200, { 'content-type': 'text/html;charset=ISO-8859-1' });
        res.end(Buffer.from('APELAÇÃO CÍVEL', 'latin1'));
        return;
      }
      case '/slow': {
        setTimeout(() => {
          res.writeHead(200);
          res.end('too late');
        }, 5_000).unref();
        return;
      }
      case '/pdf': {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(Buffer.from('%PDF-1.4\nbody\n%%EOF\n', 'latin1'));
        return;
      }
      default: {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
      }
    }
  });
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err !== undefined && err !== null ? reject(err) : resolve())),
  );
});

const client = new FetchHttpClient({ defaultTimeoutMs: 2_000 });

describe('cookies', () => {
  it('never sends an empty Cookie header — the F5 answers 200 with a rejection page if it does', async () => {
    received.length = 0;
    const jar = CookieJar.create();
    await client.send({ method: 'GET', url: `${base}/elsewhere` }, jar);
    expect(received.at(-1)?.hadCookieHeader).toBe(false);
  });

  it('sends cookies once the jar has them', async () => {
    const jar = CookieJar.create();
    await client.send({ method: 'GET', url: `${base}/set-cookies` }, jar);
    const res = await client.send({ method: 'GET', url: `${base}/scoped` }, jar);
    expect(res.text()).toContain('JSESSIONID=abc.node-1');
    expect(res.text()).toContain('ROUTER_ID=deadbeef');
  });

  it('respects cookie paths rather than sending everything everywhere', async () => {
    const jar = CookieJar.create();
    await client.send({ method: 'GET', url: `${base}/set-cookies` }, jar);
    const res = await client.send({ method: 'GET', url: `${base}/elsewhere` }, jar);
    // ROUTER_ID is Path=/ so it applies; JSESSIONID is Path=/scoped so it must not.
    expect(res.text()).toContain('ROUTER_ID=deadbeef');
    expect(res.text()).not.toContain('JSESSIONID');
  });

  it('survives a round trip through serialisation', async () => {
    const jar = CookieJar.create();
    await client.send({ method: 'GET', url: `${base}/set-cookies` }, jar);
    const restored = await CookieJar.fromJson(await jar.serialize());
    const res = await client.send({ method: 'GET', url: `${base}/scoped` }, restored);
    expect(res.text()).toContain('JSESSIONID=abc.node-1');
  });

  it('exposes cookie names for diagnostics', async () => {
    const jar = CookieJar.create();
    await client.send({ method: 'GET', url: `${base}/set-cookies` }, jar);
    expect((await jar.names(`${base}/scoped`)).sort()).toEqual(['JSESSIONID', 'ROUTER_ID']);
  });
});

describe('redirects', () => {
  it('does not follow them, and reports the absolute target', async () => {
    const jar = CookieJar.create();
    const res = await client.send({ method: 'GET', url: `${base}/redirect` }, jar);
    expect(res.status).toBe(302);
    expect(res.redirectedTo).toBe(`${base}/target`);
    expect(res.text()).not.toContain('followed');
  });

  it('leaves redirectedTo null on a normal response', async () => {
    const jar = CookieJar.create();
    const res = await client.send({ method: 'GET', url: `${base}/target` }, jar);
    expect(res.redirectedTo).toBeNull();
  });
});

describe('decoding', () => {
  it('decodes a body that is UTF-8 despite declaring latin1', async () => {
    const jar = CookieJar.create();
    const res = await client.send({ method: 'GET', url: `${base}/utf8` }, jar);
    expect(res.text()).toBe('APELAÇÃO CÍVEL');
    expect(res.charset).toBe('utf-8');
    expect(detectMojibake(res.text())).toBe(false);
  });

  it('decodes a body that really is latin1', async () => {
    const jar = CookieJar.create();
    const res = await client.send({ method: 'GET', url: `${base}/latin1` }, jar);
    expect(res.text()).toBe('APELAÇÃO CÍVEL');
    expect(res.charset).toBe('iso-8859-1');
  });

  it('memoises the decode so a large body is not decoded twice', async () => {
    const jar = CookieJar.create();
    const res = await client.send({ method: 'GET', url: `${base}/utf8` }, jar);
    expect(res.text()).toBe(res.text());
  });

  it('keeps PDF bytes untouched', async () => {
    const jar = CookieJar.create();
    const res = await client.send({ method: 'GET', url: `${base}/pdf`, expect: 'pdf' }, jar);
    expect(Buffer.from(res.bodyBytes).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('failures', () => {
  it('classifies a timeout as TIMEOUT and aborts rather than hanging', async () => {
    const jar = CookieJar.create();
    const started = Date.now();
    await expect(
      client.send({ method: 'GET', url: `${base}/slow`, timeoutMs: 300 }, jar),
    ).rejects.toMatchObject({ failureClass: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('classifies a refused connection as NETWORK', async () => {
    const jar = CookieJar.create();
    const error = await client
      .send({ method: 'GET', url: 'http://127.0.0.1:1/nope', timeoutMs: 2_000 }, jar)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpTransportError);
    expect((error as HttpTransportError).failureClass).toBe('NETWORK');
  });

  it('does not throw on a 404 — a status is data, not an exception', async () => {
    const jar = CookieJar.create();
    const res = await client.send({ method: 'GET', url: `${base}/missing` }, jar);
    expect(res.status).toBe(404);
  });

  it('returns the WAF rejection as an ordinary 200, leaving classification to the caller', async () => {
    const jar = CookieJar.create();
    const res = await client.send({ method: 'GET', url: `${base}/waf` }, jar);
    expect(res.status).toBe(200);
    expect(res.text()).toContain('Requisição - Rejeitada');
  });

  it('honours an external abort signal', async () => {
    const jar = CookieJar.create();
    const controller = new AbortController();
    const promise = client.send(
      { method: 'GET', url: `${base}/slow`, timeoutMs: 10_000, signal: controller.signal },
      jar,
    );
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(HttpTransportError);
  });
});

describe('request shape', () => {
  it('sends an identifiable user agent and the site language', async () => {
    received.length = 0;
    const jar = CookieJar.create();
    await client.send({ method: 'GET', url: `${base}/target` }, jar);
    const last = received.at(-1);
    expect(String(last?.headers['user-agent'])).toContain('juris-scraper');
    expect(last?.headers['accept-language']).toBe('pt-BR,pt;q=0.9');
  });

  it('posts a latin1-encoded body byte for byte', async () => {
    received.length = 0;
    const jar = CookieJar.create();
    await client.send(
      {
        method: 'POST',
        url: `${base}/target`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=ISO-8859-1' },
        body: new TextEncoder().encode('classe=APELA%C7%C3O'),
      },
      jar,
    );
    expect(received.at(-1)?.body).toBe('classe=APELA%C7%C3O');
  });

  it('lets an explicit header override the default', async () => {
    received.length = 0;
    const jar = CookieJar.create();
    await client.send(
      { method: 'GET', url: `${base}/target`, headers: { 'Accept-Language': 'es-CL' } },
      jar,
    );
    expect(received.at(-1)?.headers['accept-language']).toBe('es-CL');
  });

  it('measures elapsed time', async () => {
    const jar = CookieJar.create();
    const res = await client.send({ method: 'GET', url: `${base}/target` }, jar);
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(res.elapsedMs).toBeLessThan(2_000);
  });
});
