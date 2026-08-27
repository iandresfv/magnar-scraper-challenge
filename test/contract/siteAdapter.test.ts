/**
 * Runs the adapter contract against every registered site.
 *
 * `br-trf5` runs against its committed fixtures through a stub transport — no network, and the
 * same bytes the real server sent. `fake-pje` runs against a real HTTP server over a real socket.
 * Two implementations, two transports, one suite.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSite, siteIds } from '../../src/app/registry.js';
import { FetchHttpClient } from '../../src/infra/http/fetchHttpClient.js';
import { FixtureHttp, trf5FixtureRoutes } from '../support/fixtureHttp.js';
import { startFakePje, type FakePjeServer } from '../fake-pje-server/server.js';
import { runSiteAdapterContract } from './siteAdapter.contract.js';

// ── br-trf5, against the committed fixtures ──────────────────────────────────
//
// The fixture transport always answers the truncated page, so the "populated" and "truncated"
// queries are the same request. That is honest for a fixture-driven subject: what it can prove
// is that the adapter reads a real response correctly, not that the site filters.
runSiteAdapterContract({
  name: 'br-trf5 (fixtures)',
  create: () => ({
    adapter: createSite('br-trf5', { now: () => new Date('2026-08-27T13:00:00Z') }),
    http: new FixtureHttp({ routes: trf5FixtureRoutes() }),
  }),
  populatedQuery: { range: { ini: '2024-01-01', fim: '2024-12-31' }, facets: {} },
  truncatedQuery: { range: { ini: '2024-01-01', fim: '2024-12-31' }, facets: {} },
  emptyQuery: { range: { ini: '1901-01-01', fim: '1901-12-31' }, facets: {} },
});

// ── fake-pje, against a real server on a real socket ─────────────────────────

let fake: FakePjeServer;

beforeAll(async () => {
  fake = await startFakePje({ days: 60, seed: 7 });
});

afterAll(async () => {
  await fake.close();
});

runSiteAdapterContract({
  name: 'fake-pje (live server)',
  create: () => ({
    adapter: createSite('fake-pje', { baseUrl: fake.url }),
    http: new FetchHttpClient({ defaultTimeoutMs: 5_000 }),
  }),
  // A day the generator fills with 24 cases: enough rows to be interesting, under the cap.
  populatedQuery: { range: { ini: '2024-01-12', fim: '2024-01-12' }, facets: {} },
  truncatedQuery: { range: { ini: '2024-01-01', fim: '2024-03-01' }, facets: {} },
  emptyQuery: { range: { ini: '1901-01-01', fim: '1901-12-31' }, facets: {} },
});

it('the contract covered every registered site', () => {
  // If a site is added to the registry and not to this file, that is exactly the omission the
  // whole open-closed argument depends on catching.
  expect(siteIds().sort()).toEqual(['br-trf5', 'fake-pje']);
});
