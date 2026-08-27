import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSearchResponse } from '../../src/sites/br-trf5/parsers/search.js';
import { buildSearchBody, buildSearchFields } from '../../src/sites/br-trf5/searchForm.js';
import { parseListView } from '../../src/sites/br-trf5/parsers/listView.js';
import { SiteChangedError } from '../../src/core/ports/siteAdapter.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'sites',
  'br-trf5',
  'fixtures',
);

const truncated = readFileSync(join(FIXTURES, '02-search-response-30-truncado.html'), 'utf8');
const listView = readFileSync(join(FIXTURES, '01-listview-form.html'), 'utf8');

const ctx = {
  site: 'br-trf5',
  partitionId: '2024-01-01..2024-12-31',
  partitionRange: { ini: '2024-01-01', fim: '2024-12-31' },
  now: '2026-08-27T10:00:00-03:00',
  utcOffset: '-03:00',
  expectedCap: 30,
};

describe('parseSearchResponse on the real truncated fixture', () => {
  const result = parseSearchResponse(truncated, ctx);

  it('reads thirty distinct cases', () => {
    expect(result.rows).toHaveLength(30);
    expect(new Set(result.rows.map((r) => r.idOrigem)).size).toBe(30);
  });

  it('takes idOrigem straight from the cell id, with no extra request', () => {
    // The reconnaissance found the internal key sitting in `fPP:processosTable:16730:j_id255`.
    for (const row of result.rows) expect(row.idOrigem).toMatch(/^\d+$/);
    expect(result.rows.map((r) => r.idOrigem)).toContain('16730');
  });

  it('reports the cap the site itself stated', () => {
    expect(result.capSeen).toBe(30);
    expect(result.truncated).toBe(true);
  });

  it('reads the footer count the site reports', () => {
    expect(result.reportedCount).toBe(30);
    expect(result.emptyMarker).toBe(false);
  });

  it('confirms the results grid was re-rendered, so a search really ran', () => {
    expect(result.ajaxUpdateIds).toContain('fPP:processosGridPanel');
  });

  it('extracts a well-formed case number for every row', () => {
    for (const row of result.rows) {
      expect(row.numero).toMatch(/^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/);
    }
  });

  it('unescapes the ca token out of the onclick, leaving no backslash behind', () => {
    const withCa = result.rows.filter((r) => r.ca !== '');
    expect(withCa.length).toBeGreaterThan(0);
    for (const row of withCa) {
      expect(row.ca).toMatch(/^[0-9a-f]+$/);
      expect(row.ca).not.toContain('\\');
      expect(row.ca).not.toContain('x2D');
    }
  });

  it('extracts the judicial class, with its accents intact', () => {
    expect(result.classes.length).toBeGreaterThan(0);
    expect(result.classes.some((c) => c.includes('APELAÇÃO'))).toBe(true);
    for (const c of result.classes) expect(c).not.toContain('Ã‡');
  });

  it('harvests the class vocabulary for the secondary axis', () => {
    expect(new Set(result.classes).size).toBe(result.classes.length);
  });

  it('gives every row a content hash that ignores where it was found', () => {
    const again = parseSearchResponse(truncated, {
      ...ctx,
      partitionId: 'a-completely-different-leaf',
      now: '2027-01-01T00:00:00-03:00',
    });
    expect(again.rows.map((r) => r.contentHash)).toEqual(result.rows.map((r) => r.contentHash));
  });

  it('is deterministic in row order', () => {
    const ids = parseSearchResponse(truncated, ctx).rows.map((r) => r.idOrigem);
    expect(ids).toEqual(result.rows.map((r) => r.idOrigem));
  });
});

describe('the three ways a response can look empty', () => {
  /** The footer the site renders with no results: the number is absent, not zero. */
  const emptyResponse = `<?xml version="1.0"?>
    <html><head><meta name="Ajax-Update-Ids" content="fPP:processosGridPanel" /></head>
    <body><table id="fPP:processosTable"><tfoot><tr><td>
      <span class="text-muted">resultados encontrados</span>
    </td></tr></tfoot><tbody></tbody></table></body></html>`;

  it('a genuinely empty range is recognised as empty, not as a failure', () => {
    const result = parseSearchResponse(emptyResponse, ctx);
    expect(result.rows).toHaveLength(0);
    expect(result.emptyMarker).toBe(true);
    expect(result.reportedCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('C-5: the button trap is a failure, never an empty range', () => {
    // What posting `fPP:searchProcessos` actually returns: the message panel, not the grid.
    const trap = `<?xml version="1.0"?>
      <html><head><meta name="Ajax-Update-Ids" content="fPP:j_id248" /></head>
      <body><span id="fPP:j_id248"></span></body></html>`;
    try {
      parseSearchResponse(trap, ctx);
      throw new Error('expected the button trap to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(SiteChangedError);
      expect((error as SiteChangedError).canaryId).toBe('C-5');
      expect((error as SiteChangedError).message).toContain('never');
    }
  });

  it('C-10: the WAF page is a failure, never an empty range', () => {
    try {
      parseSearchResponse('<html><title>Requisição - Rejeitada</title></html>', ctx);
      throw new Error('expected the WAF page to be rejected');
    } catch (error) {
      expect((error as SiteChangedError).canaryId).toBe('C-10');
    }
  });
});

describe('truncation detection', () => {
  const rowsHtml = (n: number): string =>
    Array.from({ length: n }, (_, i) => {
      const id = 1000 + i;
      return `<tr><td class="rich-table-cell" id="fPP:processosTable:${String(id)}:j_id255">
        <a onclick="openPopUp('x','/pjeconsulta/x/listView.seam?ca=abc${String(id)}')"></a></td>
        <td class="rich-table-cell" id="fPP:processosTable:${String(id)}:j_id257">APELAÇÃO CÍVEL
        <a><b class="btn-block">ApCiv 000000${String(i % 10)}-07.1985.8.20.0124 - Assunto</b></a>
        PARTE A X PARTE B</td>
        <td class="rich-table-cell" id="fPP:processosTable:${String(id)}:j_id263">Conclusos (20/06/2026 11:18:14)</td></tr>`;
    }).join('');

  const page = (n: number, banner: boolean): string =>
    `<html><head><meta name="Ajax-Update-Ids" content="fPP:processosGridPanel" /></head><body>
     ${banner ? '<div class="alert alert-danger">Sua consulta retornou muitos processos e somente os 30 primeiros serão exibidos.</div>' : ''}
     <table><tbody>${rowsHtml(n)}</tbody>
     <tfoot><tr><td><span class="text-muted">${String(n)} resultados encontrados</span></td></tr></tfoot></table></body></html>`;

  it('treats a page at the cap as truncated even without the banner', () => {
    // Belt and braces: if the site ever stops emitting the banner, a full page must still split.
    const result = parseSearchResponse(page(30, false), ctx);
    expect(result.rows).toHaveLength(30);
    expect(result.capSeen).toBeNull();
    expect(result.truncated).toBe(true);
  });

  it('treats a partial page as complete', () => {
    const result = parseSearchResponse(page(24, false), ctx);
    expect(result.rows).toHaveLength(24);
    expect(result.truncated).toBe(false);
  });

  it('C-4: a different cap stops the run rather than adapting to it', () => {
    const changed = page(20, false).replace(
      '<tfoot>',
      '<div class="alert">somente os 20 primeiros</div><tfoot>',
    );
    try {
      parseSearchResponse(changed, ctx);
      throw new Error('expected the cap change to be fatal');
    } catch (error) {
      expect((error as SiteChangedError).canaryId).toBe('C-4');
      expect((error as SiteChangedError).message).toContain('unsafe');
    }
  });

  it('C-6: a mojibake field stops the row rather than storing corruption', () => {
    const damaged = page(1, false).replace('APELAÇÃO CÍVEL', 'APELAÃÃO');
    try {
      parseSearchResponse(damaged, ctx);
      throw new Error('expected mojibake to be rejected');
    } catch (error) {
      expect((error as SiteChangedError).canaryId).toBe('C-6');
    }
  });
});

describe('buildSearchBody', () => {
  const meta = parseListView(listView);
  const input = { meta, range: { ini: '2024-05-15', fim: '2024-05-15' } };

  it('sends the dates in the format the form expects', () => {
    const fields = buildSearchFields(input);
    expect(fields['fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate']).toBe('15/05/2024');
    expect(fields['fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate']).toBe('15/05/2024');
    expect(fields['fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate']).toBe('05/2024');
  });

  it('fires the search with the derived action id, not the visible button', () => {
    const fields = buildSearchFields(input);
    expect(fields[meta.searchActionId]).toBe(meta.searchActionId);
    expect(Object.keys(fields)).not.toContain('fPP:searchProcessos');
  });

  it('carries the ViewState the page rendered', () => {
    expect(buildSearchFields(input)['javax.faces.ViewState']).toBe(meta.viewState);
  });

  it('encodes the body in latin1 — the difference between a working filter and a silent zero', () => {
    const body = buildSearchBody({ ...input, facets: { classe: 'APELAÇÃO CÍVEL' } });
    // Ç is one byte (0xC7) in the form's charset, not the two-byte UTF-8 sequence.
    expect(body.body).toContain('APELA%C7%C3O+C%CDVEL');
    expect(body.body).not.toContain('%C3%87');
    expect(body.contentType).toContain('ISO-8859-1');
  });

  it('sends every field the form declares, including the empty ones', () => {
    // JSF binds the whole view; an omitted field is a view it did not render.
    const fields = buildSearchFields(input);
    expect(fields['fPP:dnp:nomeParte']).toBe('');
    expect(fields['fPP:Decoration:estadoComboOAB']).toContain('NoSelectionConverter');
    expect(Object.keys(fields).length).toBeGreaterThanOrEqual(20);
  });

  it('leaves the class filter empty when no facet is given', () => {
    expect(buildSearchFields(input)['fPP:j_id189:classeJudicial']).toBe('');
  });
});
