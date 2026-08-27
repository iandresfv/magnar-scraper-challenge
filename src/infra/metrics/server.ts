/**
 * A `/metrics` endpoint, in one `node:http` server and no dependency.
 *
 * It exists so that a crawl running in a container can be watched the way anything else in a
 * fleet is watched, rather than by tailing its logs. Two paths: `/metrics` for Prometheus and
 * `/healthz` for a container probe.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MetricsRegistry } from './registry.js';

export interface MetricsServer {
  port: number;
  close: () => Promise<void>;
}

export async function startMetricsServer(
  registry: MetricsRegistry,
  options: { port?: number; healthy?: () => boolean } = {},
): Promise<MetricsServer> {
  const healthy = options.healthy ?? ((): boolean => true);

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(registry.toPrometheus());
      return;
    }
    if (path === '/healthz') {
      const ok = healthy();
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' });
      res.end(ok ? 'ok\n' : 'unhealthy\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('try /metrics or /healthz\n');
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, resolve));
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err === undefined || err === null ? resolve() : reject(err))),
      ),
  };
}
