/**
 * The `detail` handler: one case, fully read.
 *
 * Two things here are worth more than the code that implements them.
 *
 * **Session recovery.** The detail page is opened with a `ca` token issued by the search that
 * listed the case. The phase-0 spike measured that the token survives another search and ten
 * minutes of idleness, which is what makes it safe for a *different* worker to pick this job up
 * — but its upper limit is unknown, and a long run will eventually exceed it. So when the site
 * says the token is dead, the handler re-runs the search for that case's own partition, finds
 * the case again, and retries with the fresh token. One extra request, and the alternative is a
 * job that can never succeed.
 *
 * **The transaction.** The case and the jobs to fetch its PDFs commit together, for the same
 * reason as in the search handler: a case whose blob jobs were lost is a case with silently
 * missing documents and nothing to indicate it.
 */
import type { BlobRecord, CaseRecord, ListedCase } from '../../domain/types.js';
import type { Job, JobQueue } from '../../ports/jobQueue.js';
import type { BlobRepo, CaseRepo } from '../../ports/repos.js';
import type { SqlExecutor } from '../../ports/sql.js';
import type { SiteAdapter, SiteSession } from '../../ports/siteAdapter.js';
import { SiteChangedError } from '../../ports/siteAdapter.js';
import type { HttpPort } from '../../ports/http.js';
import { FatalSiteChange, Outcome, type HandlerOutcome, type JobHandler } from '../pipeline.js';

export interface DetailJobPayload {
  idOrigem: string;
  ca: string;
  partitionId: string;
  partitionRange: { ini: string; fim: string };
  listed: ListedCase;
}

export interface DetailHandlerDeps {
  adapter: SiteAdapter;
  http: HttpPort;
  db: SqlExecutor;
  queue: JobQueue;
  cases: CaseRepo;
  blobs: BlobRepo;
  session: () => Promise<SiteSession>;
  /** Replaces the session after it is judged dead. */
  renewSession: () => Promise<SiteSession>;
  now: () => Date;
  /**
   * Reserves part of the run's PDF budget.
   *
   * A *reservation*, not a query: the caller asks for `n` and is told how many it may have, and
   * the budget is decremented by that amount. Asking "how much is left?" and then slicing would
   * let every detail job in the run believe the whole budget was its own — which is exactly the
   * bug this signature exists to prevent, found by asking for twelve PDFs and receiving 386.
   *
   * Returns `n` unchanged when there is no budget.
   */
  reserveBlobs?: (requested: number) => number;
  classify: (subject: unknown) => string | null;
}

export class DetailHandler implements JobHandler {
  readonly kind = 'detail' as const;

  constructor(private readonly deps: DetailHandlerDeps) {}

  async handle(job: Job): Promise<HandlerOutcome> {
    const payload = job.payload as unknown as DetailJobPayload;
    const listed = payload.listed;

    let record: CaseRecord;
    try {
      record = await this.fetch(listed);
    } catch (error) {
      if (error instanceof SiteChangedError) {
        throw new FatalSiteChange(error.canaryId, error.message);
      }
      const failureClass = this.deps.classify(error);

      // A case the site itself cannot render. Measured: roughly one token in five redirects to
      // `errorUnexpected.seam` while its neighbours from the same response work fine. Retrying
      // it six times and renewing the session would spend requests on a tribunal for nothing.
      if (failureClass === 'CLIENT_ERROR') {
        await this.deps.cases.markDetailFailed(
          job.site,
          payload.idOrigem,
          'the site could not render this case',
        );
        return Outcome.dead('CLIENT_ERROR', message(error));
      }
      if (failureClass === 'SESSION_LOST') {
        return Outcome.retry('SESSION_LOST', message(error));
      }
      throw error;
    }

    const blobs = this.deps.adapter.documentsOf(record);
    const allowed = this.deps.reserveBlobs?.(blobs.length) ?? blobs.length;
    const admitted = blobs.slice(0, Math.max(0, allowed));

    await this.deps.db.transaction(async (tx) => {
      await this.deps.cases.upsertDetailed(record, tx);

      for (const request of blobs) {
        // Every document is *registered*, even the ones the budget will not fetch this run, so
        // the report can say "known: 412, stored: 150, pending: 262" instead of pretending the
        // rest do not exist.
        const blobRecord: BlobRecord = {
          site: request.site,
          key: request.key,
          idOrigem: request.idOrigem,
          idDoc: request.idDoc,
          tipo: request.tipo,
          sourceUrl: request.url,
          storageUri: null,
          state: 'PENDING',
          bytes: null,
          sha256: null,
          contentType: null,
          storedAt: null,
        };
        await this.deps.blobs.register(blobRecord, tx);
      }

      await this.deps.queue.enqueue(
        admitted.map((request) => ({
          site: job.site,
          kind: 'blob' as const,
          key: `blob:${request.key}`,
          payload: { request },
        })),
        tx,
      );
    });

    return Outcome.done(
      `${record.numero}: ${String(record.partes.length)} parties, ` +
        `${String(record.movimentacoes.length)} movements, ` +
        `${String(admitted.length)}/${String(blobs.length)} documents queued`,
    );
  }

  /**
   * Fetches the detail, renewing the session and refreshing the token once if the site says the
   * token is dead.
   */
  private async fetch(listed: ListedCase): Promise<CaseRecord> {
    const session = await this.deps.session();
    try {
      return await this.deps.adapter.fetchDetail(this.deps.http, session, listed);
    } catch (error) {
      if (this.deps.classify(error) !== 'SESSION_LOST') throw error;

      // The recovery path: a new session, then the partition's own search re-run to obtain a
      // fresh token for this case. One extra request, and it turns an impossible job into a
      // possible one.
      const renewed = await this.deps.renewSession();
      const page = await this.deps.adapter.search(this.deps.http, renewed, {
        range: listed.partitionRange,
        facets: {},
      });
      const refreshed = page.rows.find((row) => row.idOrigem === listed.idOrigem);
      if (refreshed === undefined) {
        throw new Error(
          `case ${listed.idOrigem} was not in its own partition ${listed.partitionId} on re-search`,
          { cause: error },
        );
      }
      return this.deps.adapter.fetchDetail(this.deps.http, renewed, refreshed);
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
