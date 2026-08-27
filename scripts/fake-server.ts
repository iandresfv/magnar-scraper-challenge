/**
 * The fake tribunal, as a long-running process.
 *
 * The same server the e2e suite drives, wrapped so that `docker compose --profile app` has
 * something to crawl. Demonstrating three workers sharing a queue needs a site that can be
 * hammered; the real TRF5 is not that site, and pointing a scaling demo at a public court server
 * would be the one thing this whole project is arranged not to do.
 */
import { startFakePje } from '../test/fake-pje-server/server.js';

const port = Number(process.env['FAKE_PORT'] ?? '8080');
const days = Number(process.env['FAKE_DAYS'] ?? '120');

const server = await startFakePje({
  port,
  host: '0.0.0.0',
  days,
  seed: Number(process.env['FAKE_SEED'] ?? '20260827'),
});

process.stdout.write(
  `fake pje listening on port ${String(server.port)} · ${String(server.dataset.cases.length)} ` +
    `synthetic case(s) over ${String(days)} day(s)\n`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
