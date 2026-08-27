/**
 * The `search` handler: one partition, one query, one decision.
 *
 * It is where the coverage algorithm meets the database. The sequence is deliberate:
 *
 *   1. query the site for this partition;
 *   2. hand the answer to the coverage engine, which decides leaf / split / gap;
 *   3. in **one transaction**: store the rows, record the partition's new state, add any new
 *      facet values to the vocabulary, and enqueue the follow-up work.
 *
 * Step 3 is one transaction because the alternative is a crash between "these thirty cases
 * exist" and "somebody should fetch their details", which leaves thirty cases that will never be
 * detailed and no record that anything is missing. Everything the job learned commits together
 * or not at all.
 */
import type { ListedCase, PartitionNode } from '../../domain/types.js';
import type { Job } from '../../ports/jobQueue.js';
import type { JobQueue } from '../../ports/jobQueue.js';
import type { CaseRepo, PartitionRepo, VocabularyRepo } from '../../ports/repos.js';
import type { SqlExecutor } from '../../ports/sql.js';
import type { SearchPage, SiteAdapter } from '../../ports/siteAdapter.js';
import { SiteChangedError } from '../../ports/siteAdapter.js';
import { resolvePartition, type GapEvidence } from '../coverageEngine.js';
import { FatalSiteChange, Outcome, type HandlerOutcome, type JobHandler } from '../pipeline.js';

export interface SearchJobPayload {
  partitionId: string;
  range: { ini: string; fim: string };
  facets: Record<string, string>;
}

export interface SearchHandlerDeps {
  adapter: SiteAdapter;
  db: SqlExecutor;
  queue: JobQueue;
  cases: CaseRepo;
  partitions: PartitionRepo;
  vocabulary: VocabularyRepo;
  /** Supplies the live session; the worker owns its lifecycle. */
  session: () => Promise<Parameters<SiteAdapter['search']>[1]>;
  http: Parameters<SiteAdapter['search']>[0];
  now: () => Date;
  /** Which facet the secondary axis splits on, for vocabulary bookkeeping. */
  facetName?: string;
  onGap?: (node: PartitionNode, evidence: GapEvidence) => void;
}

export class SearchHandler implements JobHandler {
  readonly kind = 'search' as const;

  constructor(private readonly deps: SearchHandlerDeps) {}

  async handle(job: Job): Promise<HandlerOutcome> {
    const payload = job.payload as unknown as SearchJobPayload;
    const node = await this.deps.partitions.get(job.site, payload.partitionId);
    if (node === null) {
      return Outcome.dead('CLIENT_ERROR', `partition ${payload.partitionId} is not in the tree`);
    }
    if (node.status !== 'PENDING' && node.status !== 'STALE' && node.status !== 'FAILED') {
      // Already resolved by an earlier run. Re-doing it would double-count its rows.
      return Outcome.done(`partition already ${node.status}`);
    }

    let page: SearchPage;
    try {
      const session = await this.deps.session();
      page = await this.deps.adapter.search(this.deps.http, session, {
        range: node.range,
        facets: node.facets,
      });
    } catch (error) {
      if (error instanceof SiteChangedError) {
        throw new FatalSiteChange(error.canaryId, error.message);
      }
      throw error;
    }

    const now = this.deps.now().toISOString();
    const outcome = resolvePartition({
      node,
      page,
      axes: this.deps.adapter.axes,
      vocabulary: (facet) => this.vocabularyCache.get(facet) ?? [],
      now,
    });

    const facetName = this.deps.facetName ?? 'classe';
    const newValues = [...new Set(page.rows.map((row) => row.classe))].filter((v) => v !== '');

    await this.deps.db.transaction(async (tx) => {
      // The rows first: they are the point of the request.
      for (const row of page.rows) {
        await this.deps.cases.upsertListed(row, tx);
      }
      await this.deps.vocabulary.observe(job.site, facetName, newValues, tx);
      await this.deps.partitions.save(outcome.node, tx);

      if (outcome.kind === 'split') {
        for (const child of outcome.children) {
          await this.deps.partitions.save(child, tx);
        }
        await this.deps.queue.enqueue(
          outcome.children.map((child) => ({
            site: job.site,
            kind: 'search' as const,
            key: `search:${child.id}`,
            payload: {
              partitionId: child.id,
              range: child.range,
              facets: child.facets,
            } satisfies SearchJobPayload,
          })),
          tx,
        );
      }

      // Detail jobs for whatever this query found, whether the node resolved or not: a
      // truncated page's thirty rows are real cases and deserve their details either way.
      await this.deps.queue.enqueue(detailJobs(job.site, page.rows), tx);
    });

    // The vocabulary cache is refreshed after the write so the next split sees new values.
    await this.refreshVocabulary(job.site, facetName);

    if (outcome.kind === 'gap') {
      this.deps.onGap?.(outcome.node, outcome.evidence);
      return Outcome.done(
        `GAP: ${String(outcome.evidence.visibleRows)} rows visible, no axis could divide it`,
      );
    }
    if (outcome.kind === 'split') {
      return Outcome.done(`split into ${String(outcome.children.length)} children`);
    }
    return Outcome.done(`leaf with ${String(page.rows.length)} rows`);
  }

  /** Last known facet values, refreshed after each write so a split sees what the row revealed. */
  private readonly vocabularyCache = new Map<string, string[]>();

  async refreshVocabulary(site: string, facet: string): Promise<void> {
    this.vocabularyCache.set(facet, await this.deps.vocabulary.values(site, facet));
  }
}

function detailJobs(
  site: string,
  rows: readonly ListedCase[],
): { site: string; kind: 'detail'; key: string; payload: Record<string, unknown> }[] {
  return rows.map((row) => ({
    site,
    kind: 'detail' as const,
    key: `detail:${row.idOrigem}`,
    payload: {
      idOrigem: row.idOrigem,
      ca: row.ca,
      // The partition is carried so a worker that did not run the search can re-run it to
      // refresh the token, which is the recovery path for a dead session (v2 R-18).
      partitionId: row.partitionId,
      partitionRange: row.partitionRange,
      listed: row,
    },
  }));
}
