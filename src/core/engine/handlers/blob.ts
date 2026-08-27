/**
 * The `blob` handler: fetch one PDF, prove it is one, store it.
 *
 * The order is the whole point, and it is not the obvious one:
 *
 *   1. **Ask the store first.** If an object with this key is already there and its hash
 *      matches, nothing is downloaded. A resumed run therefore costs a `HEAD` per stored file
 *      instead of re-fetching every PDF it already has, and a tribunal is not asked twice for
 *      the same document.
 *   2. **Fetch.**
 *   3. **Validate before writing anything.** `%PDF-` magic, `Content-Length` agreement, `%%EOF`
 *      near the end, and a size floor. This is not belt-and-braces: when the session dies, the
 *      PDF endpoint answers `200 OK` with an HTML login page, and a downloader that trusted the
 *      status code would write a 44 KB HTML file named `…__relatorio.pdf`. Nobody would notice
 *      until a human opened it, long after the report said everything was downloaded.
 *   4. **Hash, then store, then record.** The database only learns about a file that exists.
 *
 * A validation failure is classified rather than merely logged, because the classes want
 * different things: HTML instead of a PDF is a dead session and is worth renewing for, while a
 * consistently truncated file is not worth a third attempt.
 */
import type { BlobRequest, FailureClass } from '../../domain/types.js';
import type { Job } from '../../ports/jobQueue.js';
import type { BlobStore } from '../../ports/blobStore.js';
import type { BlobRepo, CaseRepo } from '../../ports/repos.js';
import type { HttpPort } from '../../ports/http.js';
import type { SiteAdapter, SiteSession } from '../../ports/siteAdapter.js';
import { SiteChangedError } from '../../ports/siteAdapter.js';
import { blobStorageKey } from '../../domain/blobKey.js';
import { sha256Hex } from '../../domain/hash.js';
import { FatalSiteChange, Outcome, type HandlerOutcome, type JobHandler } from '../pipeline.js';

/** Injected so `core/` stays free of the blob layer's implementation. */
export interface PdfValidator {
  (input: {
    bytes: Uint8Array;
    declaredLength?: number | null;
    contentType?: string | null;
  }):
    | { ok: true; bytes: number; version: string }
    | { ok: false; reason: string; detail: string; bytes: number };
}

export interface BlobJobPayload {
  request: BlobRequest;
}

export interface BlobHandlerDeps {
  adapter: SiteAdapter;
  http: HttpPort;
  store: BlobStore;
  blobs: BlobRepo;
  cases: CaseRepo;
  session: () => Promise<SiteSession>;
  renewSession: () => Promise<SiteSession>;
  validate: PdfValidator;
  classify: (subject: unknown) => string | null;
  now: () => Date;
}

export class BlobHandler implements JobHandler {
  readonly kind = 'blob' as const;

  constructor(private readonly deps: BlobHandlerDeps) {}

  async handle(job: Job): Promise<HandlerOutcome> {
    const request = (job.payload as unknown as BlobJobPayload).request;
    if (request === undefined) {
      return Outcome.dead('CLIENT_ERROR', `blob job ${job.key} carries no request`);
    }

    const record = await this.deps.cases.get(request.site, request.idOrigem);
    const storageKey = blobStorageKey({
      site: request.site,
      numero: record?.numero ?? request.idOrigem,
      dataAutuacaoIni: record?.dataAutuacao.ini ?? null,
      tipo: request.tipo,
      idDoc: request.idDoc,
    });

    // 1. Already there? Then this run owes the site nothing for it.
    const existing = await this.deps.store.head(storageKey);
    const known = await this.deps.blobs.get(request.site, request.key);
    if (existing !== null && known?.state === 'STORED' && known.sha256 === existing.sha256) {
      return Outcome.done(`${request.key} already stored; not fetched again`);
    }

    // 2. Fetch, renewing the session once if the site says it is gone.
    let bytes: Uint8Array;
    try {
      bytes = await this.fetch(request);
    } catch (error) {
      if (error instanceof SiteChangedError) {
        throw new FatalSiteChange(error.canaryId, error.message);
      }
      const failureClass = this.deps.classify(error);
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (failureClass === 'CLIENT_ERROR') {
        await this.deps.blobs.markFailed(request.site, request.key, message);
        return Outcome.dead('CLIENT_ERROR', message);
      }
      throw error;
    }

    // 3. Prove it is a PDF. Nothing is written before this passes.
    const verdict = this.deps.validate({ bytes, declaredLength: bytes.byteLength });
    if (!verdict.ok) {
      const failureClass: FailureClass = verdict.reason === 'NOT_PDF' ? 'NOT_PDF' : 'PDF_TRUNCATED';
      const message = `${request.key}: ${verdict.reason} — ${verdict.detail}`;

      // HTML where a PDF was promised is what a dead session looks like at this endpoint, so it
      // is worth one more attempt after a renewal; a short file is not.
      await this.deps.blobs.markFailed(request.site, request.key, message);
      return Outcome.retry(failureClass, message);
    }

    // 4. Hash, store, record. In that order, so the database never claims a file that is not there.
    const sha256 = sha256Hex(bytes);
    const put = await this.deps.store.put(storageKey, bytes, {
      contentType: 'application/pdf',
      sha256,
      tags: { site: request.site, idOrigem: request.idOrigem, tipo: request.tipo },
    });

    await this.deps.blobs.markStored(request.site, request.key, {
      storageUri: put.uri,
      bytes: put.bytes,
      sha256,
      contentType: 'application/pdf',
    });

    return Outcome.done(
      `${request.key}: ${String(put.bytes)} bytes, PDF ${verdict.version}, stored at ${put.uri}`,
    );
  }

  private async fetch(request: BlobRequest): Promise<Uint8Array> {
    const session = await this.deps.session();
    try {
      return await this.deps.adapter.fetchBlob(this.deps.http, session, request);
    } catch (error) {
      if (this.deps.classify(error) !== 'SESSION_LOST') throw error;
      const renewed = await this.deps.renewSession();
      return this.deps.adapter.fetchBlob(this.deps.http, renewed, request);
    }
  }
}
