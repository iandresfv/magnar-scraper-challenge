/**
 * PDFs, end to end.
 *
 * The assertions here are about the two ways a document pipeline goes quietly wrong: it stores
 * something that is not a document, or it stores the same document twice. Both look like success
 * from the outside — a file exists, a counter went up — and only a check that opens the bytes or
 * counts the objects can tell the difference.
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { PgliteExecutor } from '../../src/infra/db/pgliteExecutor.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { createRepos } from '../../src/infra/db/repos/index.js';
import { PgJobQueue } from '../../src/infra/db/pgJobQueue.js';
import { FetchHttpClient } from '../../src/infra/http/fetchHttpClient.js';
import { FsBlobStore } from '../../src/infra/blob/fsBlobStore.js';
import { S3BlobStore } from '../../src/infra/blob/s3BlobStore.js';
import { probeS3 } from '../../src/infra/blob/factory.js';
import { validatePdf } from '../../src/infra/blob/pdfValidate.js';
import { crawlCommand } from '../../src/app/commands/crawl.js';
import { resolveConfig } from '../../src/app/config.js';
import { createSite } from '../../src/app/registry.js';
import { sha256Hex } from '../../src/core/domain/hash.js';
import { startFakePje, type FakePjeServer } from '../fake-pje-server/server.js';
import type { BlobStore } from '../../src/core/ports/blobStore.js';

const SITE = 'fake-pje';
const ROOT = { ini: '2024-01-01', fim: '2024-01-06' };
const E2E_TIMEOUT = 180_000;

let fake: FakePjeServer;
let db: SqlExecutor;
let root: string;
let store: FsBlobStore;

beforeAll(async () => {
  fake = await startFakePje({ days: 20, seed: 13 });
  db = await PgliteExecutor.create();
  await migrate(db);
}, E2E_TIMEOUT);

afterAll(async () => {
  await db.close();
  await fake.close();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  fake.clearFaults();

  // A fresh store per test, to match the fresh database. Sharing one while wiping the other
  // would leave files whose rows no longer exist — a state the crawler never produces, and one
  // that would make "a second run re-uploads nothing" measure the previous test's leftovers.
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), 'juris-e2e-blobs-'));
  store = new FsBlobStore({ root });
  await store.init();

  for (const table of [
    'job',
    'blob',
    'document',
    'movement',
    'lawyer',
    'party',
    'subject',
    'case_record',
    'partition',
    'class_vocabulary',
    'metric',
    'site_throttle',
    'crawl_run',
  ]) {
    await db.query(`DELETE FROM juris.${table}`);
  }
});

async function crawl(
  pdfBudget: string,
  blobStore: BlobStore = store,
): Promise<Awaited<ReturnType<typeof crawlCommand>>> {
  return crawlCommand({
    config: resolveConfig({
      argv: [
        'crawl',
        '--site',
        SITE,
        '--root-start',
        ROOT.ini,
        '--root-end',
        ROOT.fim,
        '--pdf-budget',
        pdfBudget,
      ],
      env: {},
    }),
    adapter: createSite(SITE, { baseUrl: fake.url }),
    http: new FetchHttpClient({ defaultTimeoutMs: 5_000 }),
    db,
    repos: createRepos(db),
    queue: new PgJobQueue(db, { defaultLeaseMs: 30_000 }),
    store: blobStore,
    log: () => undefined,
    progressEveryMs: 1_000_000,
  });
}

async function storedFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.pdf')) out.push(full);
    }
  };
  await walk(root);
  return out;
}

describe('storing PDFs', { timeout: E2E_TIMEOUT }, () => {
  it('stores real PDFs under descriptive, deterministic names', async () => {
    await crawl('8');

    const files = await storedFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      // The layout the README documents: site / year / case number / case number __ type.
      expect(file).toMatch(
        /fake-pje\/\d{4}\/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}__(relatorio|recibo(__\d+)?)\.pdf$/,
      );
      const bytes = new Uint8Array(await readFile(file));
      expect(validatePdf({ bytes, declaredLength: bytes.byteLength }).ok).toBe(true);
    }
  });

  it('records the hash and size it actually stored', async () => {
    await crawl('4');
    const repos = createRepos(db);
    const stored = [];
    for await (const blob of repos.blobs.stream({ site: SITE, state: 'STORED' })) stored.push(blob);
    expect(stored.length).toBeGreaterThan(0);

    for (const blob of stored) {
      expect(blob.storageUri).toMatch(/^file:\/\//);
      expect(blob.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(blob.contentType).toBe('application/pdf');
      expect(blob.storedAt).not.toBeNull();

      const path = decodeURIComponent(new URL(blob.storageUri ?? '').pathname);
      const bytes = new Uint8Array(await readFile(path));
      expect(sha256Hex(bytes)).toBe(blob.sha256);
      expect((await stat(path)).size).toBe(blob.bytes);
    }
  });

  it('honours the budget for the run, not per case', async () => {
    // The bug this pins down: a budget read rather than reserved lets every case believe the
    // whole allowance is its own. Twelve became 386 before it was a reservation.
    const result = await crawl('5');
    const repos = createRepos(db);
    const counts = await repos.blobs.countByState(SITE);
    expect(counts['STORED']).toBe(5);
    expect(result.exitCode).toBe(0);
  });

  it('registers every known document, including the ones the budget will not fetch', async () => {
    // So the report can say "known 104, stored 5, pending 99" rather than pretend they are gone.
    await crawl('5');
    const counts = await createRepos(db).blobs.countByState(SITE);
    expect(counts['STORED']).toBe(5);
    expect(counts['PENDING']).toBeGreaterThan(5);
  });

  it('leaves no .part file behind', async () => {
    await crawl('4');
    const partials: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.part')) partials.push(full);
      }
    };
    await walk(root);
    expect(partials).toEqual([]);
  });
});

describe('refusing to store what is not a PDF', { timeout: E2E_TIMEOUT }, () => {
  it('never writes HTML that arrived where a PDF was promised', async () => {
    // The measured symptom of a dead session at this endpoint: 200 OK, text/html, ~4 KB.
    const before = (await storedFiles()).length;
    fake.inject({ htmlInsteadOfPdf: true, times: 3 });
    await crawl('3');

    for (const file of await storedFiles()) {
      const bytes = new Uint8Array(await readFile(file));
      expect(validatePdf({ bytes }).ok, `${file} is not a valid PDF`).toBe(true);
    }

    const repos = createRepos(db);
    const failed = [];
    for await (const blob of repos.blobs.stream({ site: SITE, state: 'FAILED' })) failed.push(blob);
    // Either it failed and was recorded, or a retry succeeded — never stored as a "PDF".
    const counts = await repos.blobs.countByState(SITE);
    expect((counts['STORED'] ?? 0) + failed.length).toBeGreaterThan(0);
    expect((await storedFiles()).length).toBeGreaterThanOrEqual(before);
  });

  it('never writes a truncated PDF', async () => {
    fake.inject({ truncatePdfAt: 400, times: 3 });
    await crawl('3');
    for (const file of await storedFiles()) {
      const bytes = new Uint8Array(await readFile(file));
      expect(validatePdf({ bytes }).ok, `${file} is truncated`).toBe(true);
    }
  });

  it('records why a document could not be stored', async () => {
    // The crawl first, so the cases exist and the injected fault lands on the *document*
    // requests rather than being spent on the bootstrap and the searches.
    await crawl('0');
    fake.inject({ htmlInsteadOfPdf: true, times: 40 });
    await crawl('2');
    const repos = createRepos(db);
    const failed = [];
    for await (const blob of repos.blobs.stream({ site: SITE, state: 'FAILED' })) failed.push(blob);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.contentType).toContain('NOT_PDF');
    expect(failed[0]?.storageUri).toBeNull();
  });
});

describe('idempotency and resumption', { timeout: E2E_TIMEOUT }, () => {
  it('never re-fetches a document it already has', async () => {
    await crawl('6');
    const first = await storedFiles();
    const mtimes = new Map<string, number>();
    for (const file of first) mtimes.set(file, (await stat(file)).mtimeMs);

    // Long enough that a rewrite would show a different mtime.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await crawl('6');

    // The second run may fetch *more* — the budget is per run — but not the same ones again.
    const second = await storedFiles();
    expect(second).toEqual(expect.arrayContaining(first));
    for (const file of first) {
      expect((await stat(file)).mtimeMs, `${file} was fetched and written again`).toBe(
        mtimes.get(file),
      );
    }
  });

  it('continues through the backlog on each run, because the budget is per run', async () => {
    // `--pdf-budget N` means "this run may fetch N", not "stop once N exist in total". That is
    // what makes `--pdf-budget all` on a later run the documented way to finish the job: without
    // it, a resumed crawl would find every case already detailed and never queue the rest.
    await crawl('3');
    expect((await createRepos(db).blobs.countByState(SITE))['STORED']).toBe(3);

    await crawl('3');
    expect((await createRepos(db).blobs.countByState(SITE))['STORED']).toBe(6);

    const before = (await createRepos(db).blobs.countByState(SITE))['PENDING'] ?? 0;
    expect(before).toBeGreaterThan(0);
    await crawl('all');
    const counts = await createRepos(db).blobs.countByState(SITE);
    expect(counts['PENDING']).toBe(0);
    expect(counts['STORED']).toBe(6 + before);
  });

  it('recovers a document whose worker died holding the lease', async () => {
    await crawl('2');
    const repos = createRepos(db);
    const queue = new PgJobQueue(db, { defaultLeaseMs: 30_000 });

    // A blob job claimed by a worker that never came back.
    await queue.enqueue([
      {
        site: SITE,
        kind: 'blob',
        key: 'blob:orphan',
        payload: {
          request: {
            site: SITE,
            key: 'relatorio:orphan',
            idOrigem: 'orphan',
            idDoc: null,
            tipo: 'relatorio',
            url: `${fake.url}/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/reportPDF.seam?idProcessoTrf=10000`,
            needsSession: true,
          },
        },
      },
    ]);
    const claimed = await queue.lease(SITE, 'doomed-worker', 1);
    expect(claimed).not.toBeNull();
    if (claimed === null) throw new Error('nothing was claimed');
    await db.query(`UPDATE juris.job SET lease_until = now() - interval '1 second' WHERE id = $1`, [
      claimed.id,
    ]);

    expect(await queue.reapExpiredLeases(SITE)).toBe(1);
    const recovered = await queue.lease(SITE, 'survivor', 30_000);
    expect(recovered).not.toBeNull();
    expect(recovered?.id).toBe(claimed.id);
    expect(recovered?.leasedBy).toBe('survivor');

    // And exactly one object exists for it, not two.
    const stored = [];
    for await (const blob of repos.blobs.stream({ site: SITE, state: 'STORED' })) stored.push(blob);
    expect(new Set(stored.map((b) => b.storageUri)).size).toBe(stored.length);
  });
});

// ── the same assertions against S3, when a backend is reachable ──────────────

const s3Endpoint = process.env['S3_ENDPOINT'] ?? 'http://localhost:59000';
const s3Reachable = (await probeS3(s3Endpoint)) === null;

if (s3Reachable) {
  describe('storing PDFs in object storage', { timeout: E2E_TIMEOUT }, () => {
    it('stores the same objects under the same keys as the filesystem does', async () => {
      const bucket = 'juris-e2e-blobs';
      const s3 = new S3BlobStore({
        bucket,
        endpoint: s3Endpoint,
        region: process.env['S3_REGION'] ?? 'us-east-1',
        accessKeyId: process.env['S3_ACCESS_KEY'] ?? 'juris',
        secretAccessKey: process.env['S3_SECRET_KEY'] ?? 'jurisjuris',
        forcePathStyle: true,
      });
      await s3.init();

      await crawl('4', s3);
      const repos = createRepos(db);
      const stored = [];
      for await (const blob of repos.blobs.stream({ site: SITE, state: 'STORED' })) {
        stored.push(blob);
      }
      expect(stored).toHaveLength(4);

      for (const blob of stored) {
        expect(blob.storageUri).toMatch(new RegExp(`^s3://${bucket}/fake-pje/`));
        const key = (blob.storageUri ?? '').replace(`s3://${bucket}/`, '');
        const head = await s3.head(key);
        expect(head?.bytes).toBe(blob.bytes);
        expect(head?.sha256).toBe(blob.sha256);

        const bytes = await s3.get(key);
        expect(validatePdf({ bytes, declaredLength: bytes.byteLength }).ok).toBe(true);
        expect(sha256Hex(bytes)).toBe(blob.sha256);
      }
    });
  });
} else {
  describe('storing PDFs in object storage', () => {
    it.skip(`skipped: nothing answered at ${s3Endpoint} — run "npm run up:infra"`, () => undefined);
  });
}
