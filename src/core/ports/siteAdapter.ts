/**
 * The Strategy that makes this engine multi-site.
 *
 * Everything a court is peculiar about lives behind this interface: how a session is opened,
 * how a search is expressed, how a result page is read, how the search space can be cut into
 * pieces, which binaries exist and what "the site changed underneath us" looks like. The engine
 * knows none of it.
 *
 * Adding a court is a new folder under `sites/` plus one line in the registry. Two adapters
 * ship in v1.0 — `br-trf5` and `fake-pje` — precisely so the abstraction is exercised rather
 * than asserted: a single-implementation interface is a guess, a two-implementation interface
 * is a contract. `test/contract/siteAdapter.contract.ts` runs against every registered adapter.
 */
import type {
  BlobRequest,
  CaseRecord,
  DateRange,
  FailureClass,
  ListedCase,
  PartitionNode,
} from '../domain/types.js';
import type { CookieJarPort, HttpPort, HttpResponse } from './http.js';

export interface SiteDescriptor {
  id: string;
  country: string;
  name: string;
  baseUrl: string;
  /** IANA zone. Drives how the site's local timestamps become instants. */
  timezone: string;
  /** Fixed UTC offset, when the zone has no DST. `America/Recife` has had none since 2019. */
  utcOffset: string;
}

export interface SiteSession {
  id: string;
  jar: CookieJarPort;
  /** Whatever the adapter needs to keep: form action, ViewState, the dynamic action id. */
  state: Record<string, unknown>;
  createdAt: number;
  requests: number;
}

export interface SearchQuery {
  range: DateRange;
  /** Secondary-axis constraints, e.g. `{ classe: 'APELAÇÃO CÍVEL' }`. */
  facets: Record<string, string>;
}

export interface SearchPage {
  rows: ListedCase[];
  /** True when the site said so **or** when rows hit the cap. Belt and braces: if the banner
   *  ever disappears, a full page still forces a split rather than silently losing the tail. */
  truncated: boolean;
  /** The cap the site reported this time, parsed from its own message. Never hardcoded. */
  capSeen: number | null;
  /** The site's explicit "no results" marker, which is not the same as a failed parse. */
  emptyMarker: boolean;
}

export interface AxisContext {
  /** Values seen for a facet so far, harvested from every row of every partition. */
  vocabulary: (facet: string) => readonly string[];
  /** Identity of the node's children, so ids stay deterministic across resumptions. */
  childId: (range: DateRange, facets: Record<string, string>) => string;
}

/**
 * One way of cutting a truncated partition into smaller ones.
 *
 * The engine asks each axis in order and takes the first that can split. That ordering is the
 * whole configuration: TRF5 is `[DateAxis, ClasseAxis]`; a site with classic pagination would
 * be `[PageAxis]` and the engine would not notice the difference.
 */
export interface Axis {
  readonly name: string;
  canSplit(node: PartitionNode, page: SearchPage, ctx: AxisContext): boolean;
  split(node: PartitionNode, page: SearchPage, ctx: AxisContext): PartitionNode[];
}

export type SanitySeverity = 'error' | 'warn';

export interface SanityResult {
  id: string;
  ok: boolean;
  details: Record<string, unknown>;
}

/**
 * A canary: something that must stay true about the site, checked where it is cheapest to
 * check. The point is to fail loudly the day the site changes, instead of quietly returning
 * zero rows for a week.
 */
export interface SanityCheck {
  id: string;
  severity: SanitySeverity;
  description: string;
}

/** Raised by a parser when a canary trips. Non-retryable by construction. */
export class SiteChangedError extends Error {
  constructor(
    readonly canaryId: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SiteChangedError';
  }
}

export interface GoldenProbe {
  /** A query whose answer is known from the reconnaissance, run once at start-up. */
  query: SearchQuery;
  expectedRows: number;
  /** Fractional tolerance: 0.2 accepts 24 +/- 20 %. The dataset moves; the shape should not. */
  tolerance: number;
}

export interface SiteAdapter {
  readonly descriptor: SiteDescriptor;
  /** Ordered by priority. The engine tries each in turn and declares a GAP if none can split. */
  readonly axes: readonly Axis[];
  /** The row cap this site imposes, or `null` for a site that paginates normally. */
  readonly expectedCap: number | null;
  readonly canaries: readonly SanityCheck[];
  readonly goldenProbe?: GoldenProbe;

  bootstrap(http: HttpPort): Promise<SiteSession>;
  renew(http: HttpPort, session: SiteSession, reason: FailureClass): Promise<SiteSession>;
  search(http: HttpPort, session: SiteSession, query: SearchQuery): Promise<SearchPage>;
  fetchDetail(http: HttpPort, session: SiteSession, listed: ListedCase): Promise<CaseRecord>;
  /** Which binaries this case has and how to ask for them. Pure: no network. */
  documentsOf(record: CaseRecord): BlobRequest[];
  fetchBlob(http: HttpPort, session: SiteSession, req: BlobRequest): Promise<Uint8Array>;
  /**
   * Site-specific failure classification, tried after the generic one. Returning `null` means
   * "no opinion, use the generic answer" — this is a chain, not an override.
   */
  classify?(subject: HttpResponse | Error): FailureClass | null;
}
