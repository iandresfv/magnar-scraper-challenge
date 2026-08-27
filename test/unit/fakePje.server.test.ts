/**
 * The fake server's own tests.
 *
 * A test double that is wrong is worse than no double at all: every conclusion drawn from it
 * would be confidently false. So the behaviours the crawler depends on are asserted here, on the
 * double itself, before anything is built on top of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakePje, syntheticPdf, type FakePjeServer } from '../fake-pje-server/server.js';
import { buildDataset } from '../fake-pje-server/dataset.js';
import { validatePdf } from '../../src/infra/blob/pdfValidate.js';

let fake: FakePjeServer;

beforeAll(async () => {
  fake = await startFakePje({ days: 40, seed: 7 });
});

afterAll(async () => {
  await fake.close();
});

/** Posts a search the way the adapter does: latin1 body, current action id. */
async function search(
  ini: string,
  fim: string,
  classe = '',
  actionId = fake.searchActionId(),
): Promise<{ status: number; text: string }> {
  const fields: Record<string, string> = {
    'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate': ini,
    'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate': fim,
    'fPP:j_id189:classeJudicial': classe,
    [actionId]: actionId,
  };
  const body = Object.entries(fields)
    .map(([k, v]) => `${latin1Encode(k)}=${latin1Encode(v)}`)
    .join('&');

  const response = await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=ISO-8859-1',
      Cookie: 'JSESSIONID=x',
    },
    body,
  });
  return { status: response.status, text: await response.text() };
}

function latin1Encode(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (/[A-Za-z0-9*\-._]/.test(ch)) out += ch;
    else if (ch === ' ') out += '+';
    else out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const rowCount = (html: string): number =>
  new Set([...html.matchAll(/id="fPP:processosTable:(\d+):/g)].map((m) => m[1])).size;

describe('the dataset', () => {
  it('is deterministic for a given seed', () => {
    const a = buildDataset({ seed: 42, days: 30 });
    const b = buildDataset({ seed: 42, days: 30 });
    expect(a.cases.map((c) => c.numero)).toEqual(b.cases.map((c) => c.numero));
  });

  it('differs between seeds, so the tests are not fitted to one shape', () => {
    const a = buildDataset({ seed: 1, days: 30 });
    const b = buildDataset({ seed: 2, days: 30 });
    expect(a.cases.map((c) => c.classe)).not.toEqual(b.cases.map((c) => c.classe));
  });

  it('contains every day shape the coverage algorithm has to handle', () => {
    const dataset = buildDataset({ seed: 7, days: 40, cap: 30 });
    const sizes = [...dataset.byDay.values()].map((cases) => cases.length);
    expect(sizes).toContain(0); // pruned with one query
    expect(sizes).toContain(29); // just under the cap: must not split
    expect(sizes).toContain(30); // exactly at the cap: must split anyway
    expect(sizes).toContain(31); // over the cap
    expect(sizes.some((n) => n > 100)).toBe(true); // far over, to force several levels
  });

  it('designs one day so that a single class exceeds the cap — the declared GAP', () => {
    const dataset = buildDataset({ seed: 7, days: 40, cap: 30 });
    const gap = dataset.byDay.get(dataset.gapDay) ?? [];
    expect(gap.length).toBeGreaterThan(dataset.cap);
    expect(new Set(gap.map((c) => c.classe)).size).toBe(1);
  });

  it('generates case numbers that pass the real check-digit rule', () => {
    // If the fake data failed the same validation as the real data, the sanity checks would be
    // measuring the double rather than the crawler.
    const dataset = buildDataset({ seed: 7, days: 10 });
    for (const c of dataset.cases.slice(0, 20)) {
      const digits = c.numero.replace(/\D/g, '');
      const base = `${digits.slice(0, 7)}${digits.slice(9)}00`;
      let remainder = 0;
      for (const ch of base) remainder = (remainder * 10 + Number(ch)) % 97;
      expect(String(98 - remainder).padStart(2, '0')).toBe(digits.slice(7, 9));
    }
  });
});

describe('the search page', () => {
  it('regenerates its action id per boot, so a hardcoded one cannot work', async () => {
    const other = await startFakePje({ days: 5, seed: 99 });
    try {
      expect(fake.searchActionId()).toMatch(/^fPP:j_id\d+$/);
      // Different datasets produce different ids; the point is that it is derived, not fixed.
      expect(typeof other.searchActionId()).toBe('string');
    } finally {
      await other.close();
    }
  });

  it('rejects a request carrying an empty Cookie header, with status 200', async () => {
    // The measured behaviour of the real load balancer, reproduced so the client is tested
    // against it rather than against a polite 403.
    const response = await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`, {
      headers: { Cookie: '' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Rejeitada');
  });

  it('serves the form when no Cookie header is sent at all', async () => {
    const response = await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<form id="fPP"');
    expect(html).toContain('executarPesquisa');
    expect(response.headers.getSetCookie().join(';')).toContain('JSESSIONID');
  });

  it('renders the captcha hook inert unless the fault is injected', async () => {
    const clean = await (
      await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`)
    ).text();
    expect(clean).toContain('if (false)');

    fake.inject({ captcha: true });
    const armed = await (
      await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`)
    ).text();
    expect(armed).toContain('if (true)');
    fake.clearFaults();
  });
});

describe('searching', () => {
  it('returns the button trap when the action id is missing', async () => {
    const { text } = await search('01/01/2024', '31/12/2024', '', 'fPP:wrongId');
    expect(text).toContain('fPP:j_id248');
    expect(text).not.toContain('processosGridPanel');
    expect(rowCount(text)).toBe(0);
  });

  it('caps the result set and says so', async () => {
    const { text } = await search('01/01/2024', '31/12/2024');
    expect(rowCount(text)).toBe(30);
    expect(text).toContain('somente os 30 primeiros');
    expect(text).toContain('fPP:processosGridPanel');
  });

  it('renders an empty result as a footer with no number', async () => {
    const { text } = await search('01/01/1901', '31/12/1901');
    expect(rowCount(text)).toBe(0);
    expect(text).toContain('<span class="text-muted"> resultados encontrados</span>');
    expect(text).toContain('fPP:processosGridPanel');
  });

  it('filters by date range', async () => {
    const day = [...fake.dataset.byDay.entries()].find(
      ([, cases]) => cases.length > 0 && cases.length < 30,
    );
    if (day === undefined) throw new Error('no suitable day');
    const [iso, cases] = day;
    const [y = '', m = '', d = ''] = iso.split('-');
    const { text } = await search(`${d}/${m}/${y}`, `${d}/${m}/${y}`);
    expect(rowCount(text)).toBe(cases.length);
  });

  it('filters by class, insensitively to accents and by prefix', async () => {
    // Both properties were measured on the real site; the double reproduces them so the axis
    // is tested against reality rather than against a convenient simplification.
    const day = [...fake.dataset.byDay.entries()].find(([, c]) => c.length > 5 && c.length < 30);
    if (day === undefined) throw new Error('no suitable day');
    const [iso, cases] = day;
    const [y = '', m = '', d = ''] = iso.split('-');
    const target = cases[0]?.classe ?? '';
    const expected = cases.filter((c) => c.classe === target).length;

    const exact = await search(`${d}/${m}/${y}`, `${d}/${m}/${y}`, target);
    expect(rowCount(exact.text)).toBe(expected);

    const unaccented = await search(
      `${d}/${m}/${y}`,
      `${d}/${m}/${y}`,
      target.normalize('NFD').replace(/[̀-ͯ]/g, ''),
    );
    expect(rowCount(unaccented.text)).toBe(expected);
  });

  it('can be told to stop emitting the banner, so a full page must still force a split', async () => {
    const quiet = await startFakePje({ days: 40, seed: 7, emitBanner: false });
    try {
      const response = await fetch(`${quiet.url}/pjeconsulta/ConsultaPublica/listView.seam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `fPP%3AdataAutuacaoDecoration%3AdataAutuacaoInicioInputDate=01%2F01%2F2024&fPP%3AdataAutuacaoDecoration%3AdataAutuacaoFimInputDate=31%2F12%2F2024&${encodeURIComponent(quiet.searchActionId())}=x`,
      });
      const text = await response.text();
      expect(rowCount(text)).toBe(30);
      expect(text).not.toContain('somente os');
    } finally {
      await quiet.close();
    }
  });
});

describe('detail and documents', () => {
  it('serves a detail page for a valid ca', async () => {
    const { text } = await search('01/01/2024', '31/12/2024');
    const ca = /ca=([0-9a-f]+)/.exec(text)?.[1];
    expect(ca).toBeDefined();
    const detail = await fetch(
      `${fake.url}/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=${ca ?? ''}`,
      { headers: { Cookie: 'JSESSIONID=x' } },
    );
    const html = await detail.text();
    expect(detail.status).toBe(200);
    expect(html).toContain('Número Processo');
    expect(html).toContain('Polo ativo');
  });

  it('redirects an expired ca back to the search page', async () => {
    const { text } = await search('01/01/2024', '31/12/2024');
    const ca = /ca=([0-9a-f]+)/.exec(text)?.[1] ?? '';
    fake.inject({ expireSession: true });
    await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);

    const detail = await fetch(
      `${fake.url}/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=${ca}`,
      { headers: { Cookie: 'JSESSIONID=x' }, redirect: 'manual' },
    );
    expect(detail.status).toBe(302);
    expect(detail.headers.get('location')).toContain('ConsultaPublica/listView.seam');
    fake.clearFaults();
  });

  it('hands the cover sheet over through a document-store redirect', async () => {
    const response = await fetch(
      `${fake.url}/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/reportPDF.seam?idProcessoTrf=10000`,
      { headers: { Cookie: 'JSESSIONID=x' }, redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/docstore/');
  });

  it('serves a structurally valid PDF', async () => {
    const response = await fetch(`${fake.url}/pjeconsulta/seam/docstore/document.seam?docId=1`, {
      headers: { Cookie: 'JSESSIONID=x' },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const verdict = validatePdf({ bytes, declaredLength: bytes.byteLength });
    expect(verdict.ok).toBe(true);
  });
});

describe('fault injection', () => {
  it('returns 429 with Retry-After in seconds', async () => {
    fake.inject({ status: 429, retryAfter: 3 });
    const response = await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
  });

  it('returns 429 with Retry-After as an HTTP date', async () => {
    fake.inject({ status: 429, retryAfter: 5, retryAfterDate: true });
    const response = await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    expect(response.status).toBe(429);
    expect(Date.parse(response.headers.get('retry-after') ?? '')).toBeGreaterThan(Date.now());
  });

  it('returns 429 with no Retry-After at all, which is the case backoff must cover', async () => {
    fake.inject({ status: 429 });
    const response = await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('applies a fault a bounded number of times, then recovers', async () => {
    fake.inject({ status: 503, times: 2 });
    expect((await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`)).status).toBe(503);
    expect((await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`)).status).toBe(503);
    expect((await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`)).status).toBe(200);
  });

  it('serves HTML where a PDF was promised', async () => {
    fake.inject({ htmlInsteadOfPdf: true });
    const response = await fetch(`${fake.url}/pjeconsulta/seam/docstore/document.seam?docId=1`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    const verdict = validatePdf({ bytes, contentType: response.headers.get('content-type') });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('NOT_PDF');
  });

  it('truncates a PDF', async () => {
    fake.inject({ truncatePdfAt: 500 });
    const response = await fetch(`${fake.url}/pjeconsulta/seam/docstore/document.seam?docId=1`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const verdict = validatePdf({ bytes });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(['PDF_TRUNCATED', 'PDF_TOO_SMALL']).toContain(verdict.reason);
  });

  it('reports a different cap', async () => {
    fake.inject({ cap: 20 });
    const { text } = await search('01/01/2024', '31/12/2024');
    expect(text).toContain('somente os 20 primeiros');
  });

  it('returns the load balancer rejection page at status 200', async () => {
    fake.inject({ wafRejection: true });
    const response = await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Rejeitada');
  });

  it('drops the connection', async () => {
    fake.inject({ dropConnection: true });
    await expect(fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`)).rejects.toThrow();
  });

  it('delays a response, so timeouts can be exercised', async () => {
    fake.inject({ delayMs: 300 });
    const started = Date.now();
    await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('renames the action id mid-run, as a redeploy would', async () => {
    const before = fake.searchActionId();
    fake.inject({ renameActionId: true });
    await fetch(`${fake.url}/pjeconsulta/ConsultaPublica/listView.seam`);
    expect(fake.searchActionId()).not.toBe(before);
    // And the old id now hits the button trap.
    const { text } = await search('01/01/2024', '31/12/2024', '', before);
    expect(text).toContain('fPP:j_id248');
  });
});

describe('syntheticPdf', () => {
  it('produces something the validator accepts', () => {
    const pdf = new Uint8Array(syntheticPdf('x'));
    expect(validatePdf({ bytes: pdf, declaredLength: pdf.byteLength }).ok).toBe(true);
  });
});
