/**
 * Persistence, one repository per aggregate.
 *
 * Every write is idempotent by natural key, which is what makes re-running a crawl free: an
 * unchanged case reports `unchanged` and touches no row. Children (parties, movements,
 * documents) are replaced wholesale inside the parent's transaction rather than diffed —
 * replacement is exactly idempotent and avoids inventing fragile natural keys for a list of
 * movements.
 */
import type {
  BlobRecord,
  CaseRecord,
  CrawlRun,
  DateRange,
  ListedCase,
  PartitionNode,
  PartitionStatus,
} from '../domain/types.js';
import type { SqlSession } from './sql.js';

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged';

/** Repositories take an optional session so a caller can compose several into one transaction. */
export type Tx = SqlSession | undefined;

export interface SiteRepo {
  ensure(descriptor: {
    id: string;
    country: string;
    name: string;
    baseUrl: string;
    timezone: string;
  }): Promise<void>;
}

export interface CaseRepo {
  /** Writes what the listing knows. The detail job fills in the rest later. */
  upsertListed(listed: ListedCase, tx?: Tx): Promise<UpsertOutcome>;
  upsertDetailed(record: CaseRecord, tx?: Tx): Promise<UpsertOutcome>;
  markDetailFailed(site: string, idOrigem: string, reason: string, tx?: Tx): Promise<void>;
  get(site: string, idOrigem: string): Promise<CaseRecord | null>;
  countByState(site: string): Promise<Record<string, number>>;
  /** Streams rather than materialises: the export command must not hold a run in memory. */
  stream(filter: { site: string; state?: CaseRecord['state'] }): AsyncIterable<CaseRecord>;
}

export interface PartitionRepo {
  save(node: PartitionNode, tx?: Tx): Promise<void>;
  get(site: string, id: string): Promise<PartitionNode | null>;
  listByRun(runId: string): Promise<PartitionNode[]>;
  listByStatus(site: string, status: PartitionStatus): Promise<PartitionNode[]>;
  /** Resolved primary leaves in start order — the input to the tiling check. */
  primaryLeaves(runId: string): Promise<PartitionNode[]>;
}

export interface BlobRepo {
  register(record: BlobRecord, tx?: Tx): Promise<void>;
  markStored(
    site: string,
    key: string,
    info: { storageUri: string; bytes: number; sha256: string; contentType: string },
    tx?: Tx,
  ): Promise<void>;
  markFailed(site: string, key: string, reason: string, tx?: Tx): Promise<void>;
  get(site: string, key: string): Promise<BlobRecord | null>;
  countByState(site: string): Promise<Record<string, number>>;
  stream(filter: { site: string; state?: BlobRecord['state'] }): AsyncIterable<BlobRecord>;
}

export interface VocabularyRepo {
  /** Adds values seen in a listing. Returns how many were new, which drives STALE re-checks. */
  observe(site: string, facet: string, values: readonly string[], tx?: Tx): Promise<number>;
  values(site: string, facet: string): Promise<string[]>;
}

export interface RunRepo {
  start(run: CrawlRun): Promise<void>;
  finish(
    runId: string,
    result: { exitCode: number; summary: Record<string, unknown> },
  ): Promise<void>;
  get(runId: string): Promise<CrawlRun | null>;
  latest(site: string): Promise<CrawlRun | null>;
}

export interface MetricRepo {
  write(
    samples: readonly {
      runId: string | null;
      site: string;
      name: string;
      labels: Record<string, string>;
      value: number;
    }[],
  ): Promise<void>;
}

/** Counts used by the coverage report and the sanity checks, computed in SQL. */
export interface ReportRepo {
  casesPerMonth(site: string): Promise<{ yearMonth: string; cases: number; leaves: number }[]>;
  observedRowsVsUnique(runId: string): Promise<{ observed: number; unique: number }>;
  gapPartitions(runId: string): Promise<PartitionNode[]>;
  nullRates(site: string): Promise<Record<string, number>>;
  rootRange(runId: string): Promise<DateRange | null>;
}

export interface Repos {
  site: SiteRepo;
  cases: CaseRepo;
  partitions: PartitionRepo;
  blobs: BlobRepo;
  vocabulary: VocabularyRepo;
  runs: RunRepo;
  metrics: MetricRepo;
  reports: ReportRepo;
}
