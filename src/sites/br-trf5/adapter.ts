/**
 * The TRF5 adapter: everything this court is peculiar about, behind the generic interface.
 *
 * The engine that drives this knows nothing of JSF, of `ca` tokens, or of a thirty-row cap. It
 * asks for a session, asks for a search, and asks how to split a partition that came back
 * truncated. That separation is what makes adding a second court a folder rather than a
 * refactor — and `fake-pje` exists precisely so the claim is exercised rather than asserted.
 */
import type { BlobRequest, CaseRecord, FailureClass, ListedCase } from '../../core/domain/types.js';
import type { HttpPort, HttpResponse } from '../../core/ports/http.js';
import type {
  GoldenProbe,
  SearchPage,
  SearchQuery,
  SiteAdapter,
  SiteDescriptor,
  SiteSession,
} from '../../core/ports/siteAdapter.js';
import { SiteChangedError } from '../../core/ports/siteAdapter.js';
import { blobLogicalKey } from '../../core/domain/blobKey.js';
import { formBodyBytes } from '../../shared/form.js';
import { TRF5_AXES, CLASSE_FACET, RESIDUAL_VALUE } from './axes.js';
import { TRF5_CANARIES } from './canaries.js';
import { parseListView, type FormMeta } from './parsers/listView.js';
import { parseSearchResponse } from './parsers/search.js';
import { parseDetail } from './parsers/detail.js';
import { buildSearchBody, SEARCH_HEADERS } from './searchForm.js';
import { SESSION_LOST_PATH, UNRENDERABLE_PATH, trf5Urls, type Trf5Urls } from './urls.js';

export const TRF5_DESCRIPTOR: SiteDescriptor = {
  id: 'br-trf5',
  country: 'BR',
  name: 'TRF5 — Consulta Pública do PJe (ambiente de treinamento)',
  baseUrl: 'https://pjett.trf5.jus.br',
  timezone: 'America/Recife',
  // Brazil abolished daylight saving in 2019, so this is a constant rather than a rule set.
  utcOffset: '-03:00',
};

/**
 * The one measurement the whole run is checked against at start-up: 2024-05-15 returned exactly
 * 24 cases, untruncated, in both the reconnaissance and the phase-0 spike. A tolerance of 20 %
 * allows the dataset to move without allowing it to disappear.
 */
export const TRF5_GOLDEN_PROBE: GoldenProbe = {
  query: { range: { ini: '2024-05-15', fim: '2024-05-15' }, facets: {} },
  expectedRows: 24,
  tolerance: 0.2,
};

/** The cap the site imposes. Read from its own banner at runtime; this is only the expectation. */
export const TRF5_EXPECTED_CAP = 30;

interface Trf5SessionState extends Record<string, unknown> {
  meta: FormMeta;
}

export interface Trf5AdapterOptions {
  baseUrl?: string;
  now?: () => Date;
}

export class Trf5Adapter implements SiteAdapter {
  readonly descriptor: SiteDescriptor;
  readonly axes = TRF5_AXES;
  readonly expectedCap = TRF5_EXPECTED_CAP;
  readonly canaries = TRF5_CANARIES;
  readonly goldenProbe = TRF5_GOLDEN_PROBE;

  private readonly urls: Trf5Urls;
  private readonly now: () => Date;
  private sessionCounter = 0;

  constructor(options: Trf5AdapterOptions = {}) {
    const baseUrl = options.baseUrl ?? TRF5_DESCRIPTOR.baseUrl;
    this.descriptor = { ...TRF5_DESCRIPTOR, baseUrl };
    this.urls = trf5Urls(baseUrl);
    this.now = options.now ?? (() => new Date());
  }

  async bootstrap(http: HttpPort): Promise<SiteSession> {
    const jar = http.newJar();
    const response = await http.send({ method: 'GET', url: this.urls.listView }, jar);
    if (response.status !== 200) {
      throw new SiteChangedError(
        'C-3',
        `the search page answered ${String(response.status)} instead of 200`,
        { status: response.status },
      );
    }
    // Every canary the page can raise fires inside here.
    const meta = parseListView(response.text());
    return {
      id: `trf5-${String(++this.sessionCounter)}`,
      jar,
      state: { meta } satisfies Trf5SessionState,
      createdAt: this.now().getTime(),
      requests: 1,
    };
  }

  async renew(http: HttpPort, _session: SiteSession, _reason: FailureClass): Promise<SiteSession> {
    // A dead session is not repaired, it is replaced: a fresh jar, a fresh conversation, and a
    // freshly derived action id, because a redeploy is one of the reasons a session dies.
    return this.bootstrap(http);
  }

  async search(http: HttpPort, session: SiteSession, query: SearchQuery): Promise<SearchPage> {
    const meta = metaOf(session);
    const facets = { ...query.facets };
    // The residual node asks the same day again with no class filter; its count is what the
    // closing arithmetic compares the per-class sum against.
    if (facets[CLASSE_FACET] === RESIDUAL_VALUE) delete facets[CLASSE_FACET];

    const body = buildSearchBody({ meta, range: query.range, facets });
    const response = await http.send(
      {
        method: 'POST',
        url: `${this.urls.base}${meta.action}`,
        headers: {
          ...SEARCH_HEADERS,
          'Content-Type': body.contentType,
          Referer: this.urls.listView,
        },
        body: formBodyBytes(body),
        expect: 'html',
      },
      session.jar,
    );
    session.requests++;

    if (response.status !== 200) {
      throw new Error(`search returned ${String(response.status)}`);
    }

    const parsed = parseSearchResponse(response.text(), {
      site: this.descriptor.id,
      partitionId: partitionIdOf(query),
      partitionRange: query.range,
      now: this.now().toISOString(),
      utcOffset: this.descriptor.utcOffset,
      expectedCap: this.expectedCap,
    });

    return {
      rows: parsed.rows,
      truncated: parsed.truncated,
      capSeen: parsed.capSeen,
      emptyMarker: parsed.emptyMarker,
    };
  }

  async fetchDetail(http: HttpPort, session: SiteSession, listed: ListedCase): Promise<CaseRecord> {
    const url = this.urls.detail(listed.ca);
    const response = await http.send({ method: 'GET', url, expect: 'html' }, session.jar);
    session.requests++;

    if (response.status !== 200) {
      const failure = this.classify(response);
      throw new DetailFetchError(
        `detail for ${listed.idOrigem} answered ${String(response.status)}` +
          (response.redirectedTo === null ? '' : ` → ${response.redirectedTo}`),
        failure ?? 'SERVER_ERROR',
      );
    }

    return parseDetail(response.text(), listed, {
      site: this.descriptor.id,
      utcOffset: this.descriptor.utcOffset,
      now: this.now().toISOString(),
      detailUrl: url,
      listUrl: this.urls.listView,
    });
  }

  /**
   * Which binaries a case has. Pure: no network, no session.
   *
   * Every case has a cover sheet addressed by its own id, and each attached document has a
   * receipt addressed by `(idBin, idProcessoDoc)`. Neither needs the `ca` token, which is what
   * lets the download stage run independently of the one that produced the case.
   */
  documentsOf(record: CaseRecord): BlobRequest[] {
    const requests: BlobRequest[] = [
      {
        site: record.site,
        key: blobLogicalKey('relatorio', record.idOrigem),
        idOrigem: record.idOrigem,
        idDoc: null,
        tipo: 'relatorio',
        url: this.urls.reportPdf(record.idOrigem),
        needsSession: true,
      },
    ];

    for (const doc of record.documentos) {
      // A document with no `idBin` cannot be addressed; skipping it is honest, inventing an id
      // would be worse than the missing file.
      if (doc.idBin === null) continue;
      requests.push({
        site: record.site,
        key: blobLogicalKey('recibo', record.idOrigem, doc.idDoc),
        idOrigem: record.idOrigem,
        idDoc: doc.idDoc,
        tipo: 'recibo',
        url: this.urls.receiptPdf(doc.idBin, doc.idDoc, record.idOrigem),
        needsSession: true,
      });
    }

    return requests;
  }

  /**
   * Fetches a PDF, following the one redirect the site uses to hand it over.
   *
   * `reportPDF.seam` answers 302 towards `seam/docstore/document.seam?docId=1&cid=…`, and the
   * conversation id in that URL is per-request. The transport does not follow redirects on
   * purpose — a 302 elsewhere means something quite different — so the hop is made here, where
   * it is known to be the normal path rather than a symptom.
   */
  async fetchBlob(http: HttpPort, session: SiteSession, req: BlobRequest): Promise<Uint8Array> {
    let url = req.url;
    for (let hop = 0; hop < 3; hop++) {
      const response = await http.send({ method: 'GET', url, expect: 'pdf' }, session.jar);
      session.requests++;

      if (response.redirectedTo !== null) {
        // A redirect back to the search page is a dead session, not a step towards the file.
        if (response.redirectedTo.includes(SESSION_LOST_PATH)) {
          throw new DetailFetchError(
            `fetching ${req.key} was redirected to the search page: the session is gone`,
            'SESSION_LOST',
          );
        }
        url = response.redirectedTo;
        continue;
      }

      if (response.status !== 200) {
        throw new DetailFetchError(
          `fetching ${req.key} answered ${String(response.status)}`,
          this.classify(response) ?? 'SERVER_ERROR',
        );
      }
      return response.bodyBytes;
    }
    throw new DetailFetchError(`fetching ${req.key} exceeded the redirect budget`, 'SESSION_LOST');
  }

  /**
   * Site-specific failure classification, consulted after the generic one.
   *
   * The distinction that matters here was measured, not guessed: one `ca` in five redirects to
   * `errorUnexpected.seam` reproducibly, while its neighbours from the same response work. That
   * is a case the site cannot render, not a dead session — classifying it as `SESSION_LOST`
   * would spend six retries and a session renewal on a tribunal, every time, for nothing.
   */
  classify(subject: HttpResponse | Error): FailureClass | null {
    if (subject instanceof DetailFetchError) return subject.failureClass;
    if (subject instanceof SiteChangedError) return 'FATAL_SITE_CHANGED';
    if (subject instanceof Error) return null;

    const target = subject.redirectedTo;
    if (target !== null) {
      if (target.includes(UNRENDERABLE_PATH)) return 'CLIENT_ERROR';
      if (target.includes(SESSION_LOST_PATH)) return 'SESSION_LOST';
    }

    // The load balancer answers a rejected request with 200 and its own page, so this has to be
    // detected by content. Treated as rate limiting because backing off is what resolves it.
    if (subject.status === 200) {
      const contentType = subject.headers.get('content-type') ?? '';
      if (contentType.includes('html') && /Requisi[^<]{0,20}Rejeitada/i.test(subject.text())) {
        return 'RATE_LIMITED';
      }
    }
    return null;
  }
}

/** Carries a classification decided where the context to decide it exists. */
export class DetailFetchError extends Error {
  constructor(
    message: string,
    readonly failureClass: FailureClass,
  ) {
    super(message);
    this.name = 'DetailFetchError';
  }
}

function metaOf(session: SiteSession): FormMeta {
  const meta = (session.state as Partial<Trf5SessionState>).meta;
  if (meta === undefined) throw new Error('session has no form metadata; bootstrap it first');
  return meta;
}

/** The same id the partition tree uses, so a search job and its node always agree. */
function partitionIdOf(query: SearchQuery): string {
  const base = `${query.range.ini}..${query.range.fim}`;
  const facets = Object.entries(query.facets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return facets === '' ? base : `${base}|${facets}`;
}

export function createTrf5Adapter(options: Trf5AdapterOptions = {}): Trf5Adapter {
  return new Trf5Adapter(options);
}
