import { describe, expect, it } from 'vitest';
import { createTrf5Adapter, TRF5_EXPECTED_CAP } from '../../src/sites/br-trf5/adapter.js';
import {
  classeAxis,
  dateAxis,
  prefixCollisions,
  RESIDUAL_VALUE,
} from '../../src/sites/br-trf5/axes.js';
import { createSite, siteIds } from '../../src/app/registry.js';
import { FixtureHttp, trf5FixtureRoutes } from '../support/fixtureHttp.js';
import type { PartitionNode } from '../../src/core/domain/types.js';
import type { AxisContext, SearchPage } from '../../src/core/ports/siteAdapter.js';

const http = (): FixtureHttp => new FixtureHttp({ routes: trf5FixtureRoutes() });
const adapter = (): ReturnType<typeof createTrf5Adapter> =>
  createTrf5Adapter({ now: () => new Date('2026-08-27T13:00:00Z') });

describe('bootstrap', () => {
  it('opens a session and derives the form metadata from the real page', async () => {
    const client = http();
    const session = await adapter().bootstrap(client);
    const meta = (session.state as { meta: { searchActionId: string; viewState: string } }).meta;
    expect(meta.searchActionId).toMatch(/^fPP:j_id\d+$/);
    expect(meta.viewState).toBe('j_id1');
    expect(session.requests).toBe(1);
  });

  it('keeps the cookies the site set', async () => {
    const client = http();
    const session = await adapter().bootstrap(client);
    expect(await session.jar.headerFor('https://pjett.trf5.jus.br/pjeconsulta/x')).toContain(
      'JSESSIONID',
    );
  });

  it('asks the transport for the jar rather than building one', async () => {
    // The adapter must not know which jar implementation exists; that is the hexagonal rule.
    const client = http();
    const session = await adapter().bootstrap(client);
    expect(session.jar.constructor.name).toBe('RecordingJar');
  });
});

describe('search', () => {
  it('posts a latin1 body with the derived action id', async () => {
    const client = http();
    const subject = adapter();
    const session = await subject.bootstrap(client);
    await subject.search(client, session, {
      range: { ini: '2024-01-01', fim: '2024-12-31' },
      facets: { classe: 'APELAÇÃO CÍVEL' },
    });

    const body = client.bodies()[0] ?? '';
    expect(body).toContain('APELA%C7%C3O+C%CDVEL');
    expect(body).toContain('dataAutuacaoInicioInputDate=01%2F01%2F2024');
    const post = client.sent.find((r) => r.method === 'POST');
    expect(post?.headers?.['Content-Type']).toContain('ISO-8859-1');
    expect(post?.headers?.['X-Requested-With']).toBe('XMLHttpRequest');
  });

  it('reads the truncated fixture as thirty rows at the cap', async () => {
    const client = http();
    const subject = adapter();
    const session = await subject.bootstrap(client);
    const page = await subject.search(client, session, {
      range: { ini: '2024-01-01', fim: '2024-12-31' },
      facets: {},
    });
    expect(page.rows).toHaveLength(30);
    expect(page.truncated).toBe(true);
    expect(page.capSeen).toBe(TRF5_EXPECTED_CAP);
    expect(page.emptyMarker).toBe(false);
  });

  it('drops the class filter for the residual node, which asks the day unfiltered', async () => {
    const client = http();
    const subject = adapter();
    const session = await subject.bootstrap(client);
    await subject.search(client, session, {
      range: { ini: '2024-05-15', fim: '2024-05-15' },
      facets: { classe: RESIDUAL_VALUE },
    });
    expect(client.bodies()[0]).toContain('classeJudicial=&');
    expect(client.bodies()[0]).not.toContain('RESIDUAL');
  });
});

describe('detail and documents', () => {
  it('fetches and parses a case', async () => {
    const client = http();
    const subject = adapter();
    const session = await subject.bootstrap(client);
    const page = await subject.search(client, session, {
      range: { ini: '2024-05-15', fim: '2024-05-15' },
      facets: {},
    });
    const listed = page.rows.find((r) => r.idOrigem === '16730') ?? page.rows[0];
    if (listed === undefined) throw new Error('no rows to detail');

    const record = await subject.fetchDetail(client, session, listed);
    expect(record.state).toBe('DETAILED');
    expect(record.classe).toBe('APELAÇÃO CÍVEL');
    expect(record.partes.length).toBeGreaterThan(0);
  });

  it('derives one cover plus one receipt per attached document', async () => {
    const client = http();
    const subject = adapter();
    const session = await subject.bootstrap(client);
    const page = await subject.search(client, session, {
      range: { ini: '2024-05-15', fim: '2024-05-15' },
      facets: {},
    });
    const listed = page.rows[0];
    if (listed === undefined) throw new Error('no rows');
    const record = await subject.fetchDetail(client, session, listed);

    const blobs = subject.documentsOf(record);
    expect(blobs[0]?.tipo).toBe('relatorio');
    expect(blobs[0]?.key).toBe(`relatorio:${record.idOrigem}`);
    expect(blobs.filter((b) => b.tipo === 'recibo')).toHaveLength(2);
    expect(blobs.every((b) => b.url.startsWith('https://'))).toBe(true);
  });

  it('is pure: documentsOf makes no requests', async () => {
    const client = http();
    const subject = adapter();
    const session = await subject.bootstrap(client);
    const page = await subject.search(client, session, {
      range: { ini: '2024-05-15', fim: '2024-05-15' },
      facets: {},
    });
    const listed = page.rows[0];
    if (listed === undefined) throw new Error('no rows');
    const record = await subject.fetchDetail(client, session, listed);
    const before = client.sent.length;
    subject.documentsOf(record);
    expect(client.sent.length).toBe(before);
  });

  it('follows the docstore redirect the cover sheet uses, and returns real PDF bytes', async () => {
    const client = http();
    const subject = adapter();
    const session = await subject.bootstrap(client);
    const bytes = await subject.fetchBlob(client, session, {
      site: 'br-trf5',
      key: 'relatorio:16730',
      idOrigem: '16730',
      idDoc: null,
      tipo: 'relatorio',
      url: 'https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/reportPDF.seam?idProcessoTrf=16730',
      needsSession: true,
    });
    expect(Buffer.from(bytes).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(client.sent.some((r) => r.url.includes('docstore'))).toBe(true);
  });

  it('treats a redirect back to the search page as a lost session', async () => {
    const client = new FixtureHttp({
      routes: [
        {
          match: /reportPDF/,
          respond: () => ({
            status: 302,
            location: 'https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam',
          }),
        },
        ...trf5FixtureRoutes(),
      ],
    });
    const subject = adapter();
    const session = await subject.bootstrap(client);
    await expect(
      subject.fetchBlob(client, session, {
        site: 'br-trf5',
        key: 'relatorio:1',
        idOrigem: '1',
        idDoc: null,
        tipo: 'relatorio',
        url: 'https://pjett.trf5.jus.br/x/reportPDF.seam?idProcessoTrf=1',
        needsSession: true,
      }),
    ).rejects.toMatchObject({ failureClass: 'SESSION_LOST' });
  });
});

describe('classify', () => {
  const subject = adapter();
  const response = (over: Partial<{ status: number; location: string; body: string }>) => ({
    status: over.status ?? 200,
    headers: new Headers({ 'content-type': 'text/html' }),
    bodyBytes: new Uint8Array(),
    text: () => over.body ?? '',
    charset: 'utf-8',
    redirectedTo: over.location ?? null,
    url: 'https://x',
    elapsedMs: 1,
  });

  it('calls a redirect to the search page a lost session', () => {
    expect(
      subject.classify(
        response({ status: 302, location: '/pjeconsulta/ConsultaPublica/listView.seam' }),
      ),
    ).toBe('SESSION_LOST');
  });

  it('calls a redirect to errorUnexpected a client error, not a lost session', () => {
    // Measured: one ca in five does this reproducibly while its neighbours work. Retrying it
    // six times and renewing the session would spend requests on a tribunal for nothing.
    expect(
      subject.classify(response({ status: 302, location: '/errorUnexpected.seam?cid=98319' })),
    ).toBe('CLIENT_ERROR');
  });

  it('calls the load balancer rejection page rate limiting, because backing off fixes it', () => {
    expect(
      subject.classify(response({ status: 200, body: '<title>Requisição - Rejeitada</title>' })),
    ).toBe('RATE_LIMITED');
  });

  it('has no opinion on an ordinary response, deferring to the generic classifier', () => {
    expect(subject.classify(response({ status: 200, body: '<html>fine</html>' }))).toBeNull();
    expect(subject.classify(new Error('something else'))).toBeNull();
  });
});

describe('partition axes', () => {
  const node = (over: Partial<PartitionNode> = {}): PartitionNode => ({
    site: 'br-trf5',
    id: 'n',
    runId: 'r',
    parentId: null,
    range: { ini: '2024-01-01', fim: '2024-12-31' },
    facets: {},
    status: 'PENDING',
    observedRows: 30,
    truncated: true,
    capSeen: 30,
    attempts: 1,
    lastError: null,
    updatedAt: '2026-08-27T10:00:00-03:00',
    ...over,
  });

  const page = (classes: string[]): SearchPage => ({
    rows: classes.map((classe, i) => ({
      site: 'br-trf5',
      idOrigem: String(i),
      ca: '',
      numero: '0000001-07.1985.8.20.0124',
      classe,
      sigla: null,
      assuntoResumo: '',
      partesResumo: '',
      ultimaMovimentacao: null,
      partitionId: 'n',
      partitionRange: { ini: '2024-01-01', fim: '2024-01-01' },
      contentHash: 'h',
      listedAt: '2026-08-27T10:00:00-03:00',
    })),
    truncated: true,
    capSeen: 30,
    emptyMarker: false,
  });

  const ctx = (vocab: string[] = []): AxisContext => ({
    vocabulary: () => vocab,
    childId: (range, facets) => {
      const base = `${range.ini}..${range.fim}`;
      const f = Object.entries(facets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      return f === '' ? base : `${base}|${f}`;
    },
  });

  it('the date axis halves a multi-day range and tiles it exactly', () => {
    const parent = node();
    expect(dateAxis.canSplit(parent, page([]), ctx())).toBe(true);
    const children = dateAxis.split(parent, page([]), ctx());
    expect(children).toHaveLength(2);
    expect(children[0]?.range.ini).toBe('2024-01-01');
    expect(children[1]?.range.fim).toBe('2024-12-31');
    expect(children.every((c) => c.parentId === parent.id)).toBe(true);
    expect(children.every((c) => c.status === 'PENDING')).toBe(true);
  });

  it('the date axis gives up on a single day, handing over to the next axis', () => {
    const day = node({ range: { ini: '2024-05-15', fim: '2024-05-15' } });
    expect(dateAxis.canSplit(day, page([]), ctx())).toBe(false);
  });

  it('the class axis takes over on a single day, one child per known class', () => {
    const day = node({ range: { ini: '2024-05-15', fim: '2024-05-15' } });
    const context = ctx(['APELAÇÃO CÍVEL', 'AGRAVO DE INSTRUMENTO']);
    expect(classeAxis.canSplit(day, page([]), context)).toBe(true);

    const children = classeAxis.split(day, page([]), context);
    expect(children).toHaveLength(2);
    // Deliberately no extra "residual" child: re-asking the same day with no filter returns the
    // same truncated answer the parent already had. See the note in axes.ts.
    expect(children.map((c) => c.facets['classe'])).not.toContain(RESIDUAL_VALUE);
    expect(children.every((c) => c.range.ini === '2024-05-15')).toBe(true);
  });

  it('the class axis will not run on a multi-day range', () => {
    expect(classeAxis.canSplit(node(), page([]), ctx(['A']))).toBe(false);
  });

  it('the class axis refuses to split with an empty vocabulary — that is a declared GAP', () => {
    const day = node({ range: { ini: '2024-05-15', fim: '2024-05-15' } });
    expect(classeAxis.canSplit(day, page([]), ctx([]))).toBe(false);
  });

  it('the class axis will not split a node already filtered by class', () => {
    const day = node({
      range: { ini: '2024-05-15', fim: '2024-05-15' },
      facets: { classe: 'APELAÇÃO CÍVEL' },
    });
    expect(classeAxis.canSplit(day, page([]), ctx(['A', 'B']))).toBe(false);
  });

  it('merges the vocabulary with what the page just revealed, folding accents', () => {
    const day = node({ range: { ini: '2024-05-15', fim: '2024-05-15' } });
    const children = classeAxis.split(
      day,
      page(['APELACAO CIVEL', 'NOVA CLASSE']),
      ctx(['APELAÇÃO CÍVEL']),
    );
    const values = children.map((c) => c.facets['classe']).filter((v) => v !== RESIDUAL_VALUE);
    // The accented and unaccented spellings are the same class to this site's filter.
    expect(values).toHaveLength(2);
    expect(values).toContain('NOVA CLASSE');
  });

  it('detects prefix collisions, which break the closing arithmetic', () => {
    // Measured: the filter matches by prefix, so `APELAÇÃO` also returns `APELAÇÃO CÍVEL`.
    expect(prefixCollisions(['APELAÇÃO', 'APELAÇÃO CÍVEL'])).toEqual([
      { shorter: 'APELAÇÃO', longer: 'APELAÇÃO CÍVEL' },
    ]);
    expect(prefixCollisions(['APELAÇÃO CÍVEL', 'AGRAVO DE INSTRUMENTO'])).toEqual([]);
  });

  it('finds no prefix collision among the twenty classes the spike harvested', () => {
    const harvested = [
      'AGRAVO DE INSTRUMENTO',
      'AGRAVO INTERNO CÍVEL',
      'AGRAVO REGIMENTAL CÍVEL',
      'APELAÇÃO / REMESSA NECESSÁRIA',
      'APELAÇÃO CRIMINAL',
      'APELAÇÃO CÍVEL',
      'AÇÃO PENAL - PROCEDIMENTO ORDINÁRIO',
      'AÇÃO RESCISÓRIA',
      'CONFLITO DE COMPETÊNCIA CÍVEL',
      'CONFLITO DE JURISDIÇÃO',
      'HABEAS CORPUS CRIMINAL',
      'MANDADO DE SEGURANÇA CÍVEL',
      'PEDIDO DE EFEITO SUSPENSIVO À APELAÇÃO',
      'PEDIDO DE UNIFORMIZAÇÃO DE INTERPRETAÇÃO DE LEI CÍVEL',
      'PROCEDIMENTO COMUM CÍVEL',
      'PROCEDIMENTO INVESTIGATÓRIO CRIMINAL (PIC-MP)',
      'RECLAMAÇÃO',
      'RECURSO EM SENTIDO ESTRITO',
      'REMESSA NECESSÁRIA CÍVEL',
      'TUTELA ANTECIPADA ANTECEDENTE',
    ];
    expect(prefixCollisions(harvested)).toEqual([]);
  });
});

describe('registry', () => {
  it('knows the TRF5 adapter', () => {
    expect(siteIds()).toContain('br-trf5');
    expect(createSite('br-trf5').descriptor.country).toBe('BR');
  });

  it('names the known sites when asked for one that does not exist', () => {
    expect(() => createSite('pe-cej')).toThrow(/unknown site "pe-cej".*br-trf5/s);
  });

  it('exposes the axes in priority order', () => {
    expect(createSite('br-trf5').axes.map((a) => a.name)).toEqual(['date', 'classe']);
  });

  it('carries a golden probe and the canary catalogue', () => {
    const site = createSite('br-trf5');
    expect(site.goldenProbe?.expectedRows).toBe(24);
    expect(site.canaries.length).toBeGreaterThanOrEqual(9);
    expect(site.expectedCap).toBe(30);
  });
});
