/**
 * The second site.
 *
 * It talks to the fake PJe server, and its purpose is to keep `SiteAdapter` honest. An interface
 * with one implementation is a guess about what varies; this one proves which parts of the TRF5
 * adapter were genuinely site-specific and which were incidental.
 *
 * What it **reuses** is the parsing, because the fake server reproduces the same HTML contract —
 * that reuse is the finding, not a shortcut: it says the parsers depend on the document shape
 * rather than on the host. What it **replaces** is everything that is genuinely per-site: the
 * descriptor, the base URL, the timezone, the golden probe (its dataset is synthetic, so the
 * expected count is different), and the failure classification.
 *
 * It also carries a deliberately different partition configuration. The date axis is shared, but
 * this site's `expectedCap` comes from its own configuration rather than a constant, which is
 * what a court with a different cap would need — and proves the engine reads it from the adapter
 * rather than assuming thirty.
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
import { TRF5_AXES, CLASSE_FACET, RESIDUAL_VALUE } from '../br-trf5/axes.js';
import { TRF5_CANARIES } from '../br-trf5/canaries.js';
import { parseListView, type FormMeta } from '../br-trf5/parsers/listView.js';
import { parseSearchResponse } from '../br-trf5/parsers/search.js';
import { parseDetail } from '../br-trf5/parsers/detail.js';
import { buildSearchBody, SEARCH_HEADERS } from '../br-trf5/searchForm.js';

export interface FakePjeAdapterOptions {
  /** Where the fake server is listening. Required: there is no meaningful default. */
  baseUrl: string;
  now?: () => Date;
  expectedCap?: number;
  goldenProbe?: GoldenProbe;
}

const APP = '/pjeconsulta';

export class FakePjeAdapter implements SiteAdapter {
  readonly descriptor: SiteDescriptor;
  readonly axes = TRF5_AXES;
  readonly expectedCap: number;
  readonly canaries = TRF5_CANARIES;
  readonly goldenProbe?: GoldenProbe;

  private readonly now: () => Date;
  private counter = 0;

  constructor(private readonly options: FakePjeAdapterOptions) {
    this.descriptor = {
      id: 'fake-pje',
      country: 'BR',
      name: 'Fake PJe (test double)',
      baseUrl: options.baseUrl,
      timezone: 'America/Recife',
      utcOffset: '-03:00',
    };
    this.expectedCap = options.expectedCap ?? 30;
    if (options.goldenProbe !== undefined) this.goldenProbe = options.goldenProbe;
    this.now = options.now ?? (() => new Date());
  }

  private get listViewUrl(): string {
    return `${this.options.baseUrl}${APP}/ConsultaPublica/listView.seam`;
  }

  async bootstrap(http: HttpPort): Promise<SiteSession> {
    const jar = http.newJar();
    const response = await http.send({ method: 'GET', url: this.listViewUrl }, jar);
    if (response.status !== 200) {
      // A refusal is not a redesign. A 429, a 5xx or a dropped connection during bootstrap is
      // exactly the kind of thing the retry policy exists for, and calling it a site change
      // would stop the whole run over a server having a bad minute. Only a 200 that does not
      // contain the form is evidence the page itself changed — and that is decided below.
      throw new FakeFetchError(
        `the search page answered ${String(response.status)} instead of 200`,
        response.status === 429
          ? 'RATE_LIMITED'
          : response.status >= 500
            ? 'SERVER_ERROR'
            : 'CLIENT_ERROR',
      );
    }
    const meta = parseListView(response.text());
    return {
      id: `fake-${String(++this.counter)}`,
      jar,
      state: { meta },
      createdAt: this.now().getTime(),
      requests: 1,
    };
  }

  async renew(http: HttpPort, _session: SiteSession, _reason: FailureClass): Promise<SiteSession> {
    return this.bootstrap(http);
  }

  async search(http: HttpPort, session: SiteSession, query: SearchQuery): Promise<SearchPage> {
    const meta = metaOf(session);
    const facets = { ...query.facets };
    if (facets[CLASSE_FACET] === RESIDUAL_VALUE) delete facets[CLASSE_FACET];

    const body = buildSearchBody({ meta, range: query.range, facets });
    const response = await http.send(
      {
        method: 'POST',
        url: `${this.options.baseUrl}${meta.action}`,
        headers: {
          ...SEARCH_HEADERS,
          'Content-Type': body.contentType,
          Referer: this.listViewUrl,
        },
        body: formBodyBytes(body),
        expect: 'html',
      },
      session.jar,
    );
    session.requests++;

    if (response.status !== 200) throw new Error(`search returned ${String(response.status)}`);

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
    const url = `${this.options.baseUrl}${APP}/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=${listed.ca}`;
    const response = await http.send({ method: 'GET', url, expect: 'html' }, session.jar);
    session.requests++;

    if (response.status !== 200) {
      throw new FakeFetchError(
        `detail for ${listed.idOrigem} answered ${String(response.status)}`,
        this.classify(response) ?? 'SERVER_ERROR',
      );
    }

    return parseDetail(response.text(), listed, {
      site: this.descriptor.id,
      utcOffset: this.descriptor.utcOffset,
      now: this.now().toISOString(),
      detailUrl: url,
      listUrl: this.listViewUrl,
    });
  }

  documentsOf(record: CaseRecord): BlobRequest[] {
    const detailPath = `${APP}/ConsultaPublica/DetalheProcessoConsultaPublica`;
    const requests: BlobRequest[] = [
      {
        site: record.site,
        key: blobLogicalKey('relatorio', record.idOrigem),
        idOrigem: record.idOrigem,
        idDoc: null,
        tipo: 'relatorio',
        url: `${this.options.baseUrl}${detailPath}/reportPDF.seam?idProcessoTrf=${record.idOrigem}`,
        needsSession: true,
      },
    ];
    for (const doc of record.documentos) {
      if (doc.idBin === null) continue;
      requests.push({
        site: record.site,
        key: blobLogicalKey('recibo', record.idOrigem, doc.idDoc),
        idOrigem: record.idOrigem,
        idDoc: doc.idDoc,
        tipo: 'recibo',
        url:
          `${this.options.baseUrl}${APP}/Processo/reportReciboPDF.seam` +
          `?idBin=${doc.idBin}&idProcessoDoc=${doc.idDoc}&idProcessoTrf=${record.idOrigem}`,
        needsSession: true,
      });
    }
    return requests;
  }

  async fetchBlob(http: HttpPort, session: SiteSession, req: BlobRequest): Promise<Uint8Array> {
    let url = req.url;
    for (let hop = 0; hop < 3; hop++) {
      const response = await http.send({ method: 'GET', url, expect: 'pdf' }, session.jar);
      session.requests++;

      if (response.redirectedTo !== null) {
        if (response.redirectedTo.includes('/ConsultaPublica/listView.seam')) {
          throw new FakeFetchError(`fetching ${req.key} lost the session`, 'SESSION_LOST');
        }
        url = new URL(response.redirectedTo, this.options.baseUrl).toString();
        continue;
      }
      if (response.status !== 200) {
        throw new FakeFetchError(
          `fetching ${req.key} answered ${String(response.status)}`,
          this.classify(response) ?? 'SERVER_ERROR',
        );
      }
      return response.bodyBytes;
    }
    throw new FakeFetchError(`fetching ${req.key} exceeded the redirect budget`, 'SESSION_LOST');
  }

  classify(subject: HttpResponse | Error): FailureClass | null {
    if (subject instanceof FakeFetchError) return subject.failureClass;
    if (subject instanceof SiteChangedError) return 'FATAL_SITE_CHANGED';
    if (subject instanceof Error) return null;

    if (subject.redirectedTo?.includes('/ConsultaPublica/listView.seam') === true) {
      return 'SESSION_LOST';
    }
    if (subject.status === 200 && /Requisi[^<]{0,20}Rejeitada/i.test(subject.text())) {
      return 'RATE_LIMITED';
    }
    return null;
  }
}

export class FakeFetchError extends Error {
  constructor(
    message: string,
    readonly failureClass: FailureClass,
  ) {
    super(message);
    this.name = 'FakeFetchError';
  }
}

function metaOf(session: SiteSession): FormMeta {
  const meta = (session.state as { meta?: FormMeta }).meta;
  if (meta === undefined) throw new Error('session has no form metadata; bootstrap it first');
  return meta;
}

function partitionIdOf(query: SearchQuery): string {
  const base = `${query.range.ini}..${query.range.fim}`;
  const facets = Object.entries(query.facets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return facets === '' ? base : `${base}|${facets}`;
}

export function createFakePjeAdapter(options: FakePjeAdapterOptions): FakePjeAdapter {
  return new FakePjeAdapter(options);
}
