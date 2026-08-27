/**
 * The `SiteAdapter` contract. Every registered site must pass it.
 *
 * This is what turns "the architecture is multi-site" from a claim into a check. The suite knows
 * nothing about PJe, JSF, or a thirty-row cap; it only knows what the port promises. An adapter
 * that satisfies it can be driven by the engine, and one that does not fails the build — which
 * is exactly the guardrail someone adding a Peruvian court will want.
 *
 * The two adapters that run it are as different as the project has: one reads committed fixtures
 * through a stub transport, the other speaks HTTP to a real server over a real socket.
 */
import { describe, expect, it } from 'vitest';
import type { HttpPort } from '../../src/core/ports/http.js';
import type { SearchQuery, SiteAdapter } from '../../src/core/ports/siteAdapter.js';
import { detectMojibake } from '../../src/core/domain/text.js';
import { parseCaseNumber } from '../../src/core/domain/cnj.js';

export interface AdapterSubject {
  name: string;
  /** A fresh adapter and transport. Called once per test so nothing leaks between them. */
  create: () =>
    Promise<{ adapter: SiteAdapter; http: HttpPort }> | { adapter: SiteAdapter; http: HttpPort };
  /** A query the site answers with rows, at least one of which has documents. */
  populatedQuery: SearchQuery;
  /** A query the site answers with no rows at all. */
  emptyQuery: SearchQuery;
  /** A query wide enough to be truncated. */
  truncatedQuery: SearchQuery;
}

export function runSiteAdapterContract(subject: AdapterSubject): void {
  describe(`SiteAdapter contract: ${subject.name}`, () => {
    const open = async (): Promise<{
      adapter: SiteAdapter;
      http: HttpPort;
      session: Awaited<ReturnType<SiteAdapter['bootstrap']>>;
    }> => {
      const { adapter, http } = await subject.create();
      const session = await adapter.bootstrap(http);
      return { adapter, http, session };
    };

    describe('descriptor', () => {
      it('identifies itself completely enough to be stored', async () => {
        const { adapter } = await subject.create();
        const d = adapter.descriptor;
        expect(d.id).toMatch(/^[a-z0-9-]+$/);
        expect(d.country).toMatch(/^[A-Z]{2}$/);
        expect(d.name.length).toBeGreaterThan(3);
        expect(d.baseUrl).toMatch(/^https?:\/\//);
        expect(d.timezone).toContain('/');
        expect(d.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/);
      });

      it('declares at least one partition axis, in priority order', async () => {
        const { adapter } = await subject.create();
        expect(adapter.axes.length).toBeGreaterThan(0);
        for (const axis of adapter.axes) expect(axis.name).not.toBe('');
      });

      it('declares its row cap, or null if it paginates instead', async () => {
        const { adapter } = await subject.create();
        expect(adapter.expectedCap === null || adapter.expectedCap > 0).toBe(true);
      });

      it('carries canaries, because a site that cannot break is a site nobody checked', async () => {
        const { adapter } = await subject.create();
        expect(adapter.canaries.length).toBeGreaterThan(0);
        for (const canary of adapter.canaries) {
          expect(canary.id).not.toBe('');
          expect(['error', 'warn']).toContain(canary.severity);
        }
      });
    });

    describe('bootstrap', () => {
      it('produces a usable session', async () => {
        const { session } = await open();
        expect(session.id).not.toBe('');
        expect(session.requests).toBeGreaterThan(0);
        expect(session.createdAt).toBeGreaterThan(0);
      });

      it('gives the session a cookie jar it did not have to construct itself', async () => {
        const { session } = await open();
        expect(typeof session.jar.headerFor).toBe('function');
      });

      it('renew produces a working session too', async () => {
        const { adapter, http, session } = await open();
        const renewed = await adapter.renew(http, session, 'SESSION_LOST');
        const page = await adapter.search(http, renewed, subject.populatedQuery);
        expect(page.rows.length).toBeGreaterThan(0);
      });
    });

    describe('search', () => {
      it('returns rows for a populated range', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.populatedQuery);
        expect(page.rows.length).toBeGreaterThan(0);
      });

      it('gives every row the identity the engine deduplicates on', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.populatedQuery);
        for (const row of page.rows) {
          expect(row.site).toBe(adapter.descriptor.id);
          expect(row.idOrigem).not.toBe('');
          expect(row.numero).not.toBe('');
          expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(new Set(page.rows.map((r) => r.idOrigem)).size).toBe(page.rows.length);
      });

      it('produces case numbers that parse', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.populatedQuery);
        for (const row of page.rows) {
          expect(parseCaseNumber(row.numero), `${row.numero} did not parse`).not.toBeNull();
        }
      });

      it('returns text free of mojibake', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.populatedQuery);
        for (const row of page.rows) {
          for (const value of [row.classe, row.assuntoResumo, row.partesResumo]) {
            expect(detectMojibake(value), `mojibake in ${JSON.stringify(value)}`).toBe(false);
          }
        }
      });

      it('marks an empty range as empty rather than as a failure', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.emptyQuery);
        expect(page.rows).toHaveLength(0);
        expect(page.emptyMarker).toBe(true);
        expect(page.truncated).toBe(false);
      });

      it('marks a wide range as truncated, so the engine knows to split', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.truncatedQuery);
        expect(page.truncated).toBe(true);
        if (adapter.expectedCap !== null) {
          expect(page.rows.length).toBe(adapter.expectedCap);
        }
      });

      it('reports the cap the site itself stated, not one we assumed', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.truncatedQuery);
        if (page.capSeen !== null) expect(page.capSeen).toBe(adapter.expectedCap);
      });

      it('is repeatable: the same query twice yields the same identities', async () => {
        const { adapter, http, session } = await open();
        const first = await adapter.search(http, session, subject.populatedQuery);
        const second = await adapter.search(http, session, subject.populatedQuery);
        expect(second.rows.map((r) => r.idOrigem)).toEqual(first.rows.map((r) => r.idOrigem));
        expect(second.rows.map((r) => r.contentHash)).toEqual(first.rows.map((r) => r.contentHash));
      });
    });

    describe('detail', () => {
      it('turns a listed row into a complete record', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.populatedQuery);
        const listed = page.rows[0];
        if (listed === undefined) throw new Error('no rows to detail');

        const record = await adapter.fetchDetail(http, session, listed);
        expect(record.site).toBe(adapter.descriptor.id);
        expect(record.idOrigem).toBe(listed.idOrigem);
        expect(record.state).toBe('DETAILED');
        expect(record.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(record.detailedAt).not.toBeNull();
      });

      it('keeps the partition range that listed the case', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.populatedQuery);
        const listed = page.rows[0];
        if (listed === undefined) throw new Error('no rows');
        const record = await adapter.fetchDetail(http, session, listed);
        expect(record.dataAutuacao).toEqual(listed.partitionRange);
      });

      it('produces a record with no mojibake anywhere in it', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.populatedQuery);
        const listed = page.rows[0];
        if (listed === undefined) throw new Error('no rows');
        const record = await adapter.fetchDetail(http, session, listed);
        expect(detectMojibake(JSON.stringify(record))).toBe(false);
      });
    });

    describe('documents', () => {
      it('is pure and deterministic', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.populatedQuery);
        const listed = page.rows[0];
        if (listed === undefined) throw new Error('no rows');
        const record = await adapter.fetchDetail(http, session, listed);

        const first = adapter.documentsOf(record);
        const second = adapter.documentsOf(record);
        expect(second).toEqual(first);
      });

      it('gives every request a stable key and an absolute url', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.populatedQuery);
        const listed = page.rows[0];
        if (listed === undefined) throw new Error('no rows');
        const record = await adapter.fetchDetail(http, session, listed);

        const requests = adapter.documentsOf(record);
        expect(requests.length).toBeGreaterThan(0);
        for (const req of requests) {
          expect(req.site).toBe(adapter.descriptor.id);
          expect(req.key).toContain(record.idOrigem);
          expect(req.url).toMatch(/^https?:\/\//);
        }
        expect(new Set(requests.map((r) => r.key)).size).toBe(requests.length);
      });

      it('fetches bytes that begin like a PDF', async () => {
        const { adapter, http, session } = await open();
        const page = await adapter.search(http, session, subject.populatedQuery);
        const listed = page.rows[0];
        if (listed === undefined) throw new Error('no rows');
        const record = await adapter.fetchDetail(http, session, listed);
        const request = adapter.documentsOf(record)[0];
        if (request === undefined) throw new Error('no documents');

        const bytes = await adapter.fetchBlob(http, session, request);
        expect(Buffer.from(bytes).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      });
    });

    describe('classification', () => {
      it('has no opinion on an unrelated error, deferring to the generic classifier', async () => {
        const { adapter } = await subject.create();
        expect(adapter.classify?.(new Error('unrelated')) ?? null).toBeNull();
      });
    });
  });
}
