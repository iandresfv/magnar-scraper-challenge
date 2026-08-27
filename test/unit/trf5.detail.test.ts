/**
 * The detail parser, against the real page.
 *
 * The assertions are written against values that were **read and checked by hand** first, not
 * captured from whatever the parser happened to produce. Three of them encode bugs that were
 * live during development and would otherwise have shipped as `null` columns nobody questioned:
 * the nested `propertyView` wrapper, the `<b>`-labelled fields, and the site's own unclosed
 * parenthesis in the subject hierarchy.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDetail } from '../../src/sites/br-trf5/parsers/detail.js';
import { SiteChangedError } from '../../src/core/ports/siteAdapter.js';
import type { ListedCase } from '../../src/core/domain/types.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'sites',
  'br-trf5',
  'fixtures',
);

const detailHtml = readFileSync(join(FIXTURES, '03-detalhe-processo-16730.html'), 'utf8');

const listed: ListedCase = {
  site: 'br-trf5',
  idOrigem: '16730',
  ca: 'b22ef4ac',
  numero: '0000007-07.1985.8.20.0124',
  classe: 'APELAÇÃO CÍVEL',
  sigla: 'ApCiv',
  assuntoResumo: 'Multas e demais Sanções',
  partesResumo: 'EMPRESA NOSSA SENHORA APARECIDA LTDA e outros (3) X FAZENDA NACIONAL',
  ultimaMovimentacao: null,
  partitionId: '2024-05-15..2024-05-15',
  partitionRange: { ini: '2024-05-15', fim: '2024-05-15' },
  contentHash: 'listing-hash',
  listedAt: '2026-08-27T10:00:00-03:00',
};

const ctx = {
  site: 'br-trf5',
  utcOffset: '-03:00',
  now: '2026-08-27T10:05:00-03:00',
  detailUrl: 'https://pjett.trf5.jus.br/detail',
  listUrl: 'https://pjett.trf5.jus.br/list',
};

const record = parseDetail(detailHtml, listed, ctx);

describe('scalar fields', () => {
  it('reads the case number and validates its check digit', () => {
    expect(record.numero).toBe('0000007-07.1985.8.20.0124');
    expect(record.numeroNorm).toBe('00000070719858200124');
    expect(record.numeroParts?.valido).toBe(true);
    expect(record.numeroParts?.ano).toBe(1985);
  });

  it('splits the class from its code', () => {
    expect(record.classe).toBe('APELAÇÃO CÍVEL');
    expect(record.classeCodigo).toBe(198);
  });

  it('reads the distribution date as a calendar day', () => {
    expect(record.dataDistribuicao).toBe('2024-05-15');
  });

  it('confirms SUP-3: the distribution date matches the partition that listed it', () => {
    expect(record.dataDistribuicao).toBe(listed.partitionRange.ini);
  });

  it('reads the fields the site labels with <b> instead of <label>', () => {
    // These three sit inside a propertyView whose <label> is empty, as
    // `<b>Órgão Julgador</b><br/>Gab VICE-PRESIDÊNCIA`. A parser that only knows the
    // name/value shape reports all three as null and looks like the page changed.
    expect(record.orgaoJulgador).toBe('Gab VICE-PRESIDÊNCIA');
    expect(record.orgaoJulgadorColegiado).toBe('Pleno');
    expect(record.endereco).toContain('Cais do Apolo');
  });

  it('reads the fields the site labels normally', () => {
    expect(record.jurisdicao).toBe('TRF5');
    expect(record.processoReferencia).toBe('0000007-07.1985.8.20.0124');
  });

  it('keeps every accent intact', () => {
    expect(record.classe).toContain('Ç');
    expect(record.orgaoJulgador).toContain('Ê');
    expect(JSON.stringify(record)).not.toContain('Ã‡');
  });
});

describe('subject hierarchy', () => {
  it('recovers every code the site stated, despite its own unclosed parenthesis', () => {
    // The source reads `… Decretação de Ofício (10548 DIREITO ADMINISTRATIVO … (9985) …`.
    // That missing `)` is the site's defect, not ours; splitting on ` - ` would merge two
    // subjects into one and lose a code.
    expect(record.assuntos.map((a) => a.codigo)).toEqual([
      14, 5986, 5990, 5992, 10548, 9985, 9997, 10022, 10023,
    ]);
  });

  it('numbers the levels in document order', () => {
    expect(record.assuntos.map((a) => a.nivel)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('keeps the descriptions clean, with no leading separator', () => {
    expect(record.assuntos[0]?.descricao).toBe('DIREITO TRIBUTÁRIO');
    expect(record.assuntos[1]?.descricao).toBe('Crédito Tributário');
    expect(record.assuntos[8]?.descricao).toBe('Multas e demais Sanções');
    for (const a of record.assuntos) expect(a.descricao).not.toMatch(/^\s*-/);
  });
});

describe('parties', () => {
  it('reads every participant from both poles', () => {
    expect(record.partes).toHaveLength(5);
    expect(record.partes.filter((p) => p.polo === 'ATIVO')).toHaveLength(4);
    expect(record.partes.filter((p) => p.polo === 'PASSIVO')).toHaveLength(1);
  });

  it('parses and validates the identifiers', () => {
    const company = record.partes.find((p) => p.nome.includes('APARECIDA'));
    expect(company?.documento?.kind).toBe('CNPJ');
    expect(company?.documento?.digits).toBe('08409021000177');
    expect(company?.documento?.valid).toBe(true);

    const person = record.partes.find((p) => p.nome === 'LUIS ALVES DE ARAUJO');
    expect(person?.documento?.kind).toBe('CPF');
    expect(person?.documento?.valid).toBe(true);
  });

  it('reads the participation type and the situação column', () => {
    expect(record.partes[0]?.tipoParticipacao).toBe('APELANTE');
    expect(record.partes.find((p) => p.polo === 'PASSIVO')?.tipoParticipacao).toBe('APELADO');
    expect(record.partes[0]?.situacao).toBe('Ativo');
  });

  it('numbers participants per pole, so the primary key is stable', () => {
    expect(record.partes.filter((p) => p.polo === 'ATIVO').map((p) => p.ordem)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(record.partes.filter((p) => p.polo === 'PASSIVO').map((p) => p.ordem)).toEqual([0]);
  });

  it('finds no lawyers, because this case genuinely has none', () => {
    // The page mentions "advogado" six times, all of it in the site's own footer and metadata.
    // Counting those would have invented three lawyers for a case that lists zero.
    expect(record.advogados).toHaveLength(0);
  });

  it('reads a lawyer when one is present', () => {
    // The real fixture has none, so the lawyer branch is exercised against the shape the
    // reconnaissance documented rather than left untested.
    const passivo =
      '<span class="text-bold">FAZENDA NACIONAL - CNPJ: 00.394.460/0216-53 (APELADO)</span>';
    expect(detailHtml).toContain(passivo);
    const synthetic = detailHtml.replace(
      passivo,
      `${passivo}<span class="text-bold">JOANA DA SILVA - OAB RN1966 - CPF: 474.225.484-87 (ADVOGADO)</span>`,
    );
    const withLawyer = parseDetail(synthetic, listed, ctx);
    const lawyer = withLawyer.advogados[0];
    expect(withLawyer.advogados).toHaveLength(1);
    expect(lawyer?.nome).toBe('JOANA DA SILVA');
    expect(lawyer?.registro).toEqual({ uf: 'RN', numero: '1966' });
    expect(lawyer?.documento?.kind).toBe('CPF');
    expect(lawyer?.documento?.valid).toBe(true);
    // And it must not also appear as a party.
    expect(withLawyer.partes.some((p) => p.nome === 'JOANA DA SILVA')).toBe(false);
  });
});

describe('movements', () => {
  it('reads the full history, newest first', () => {
    expect(record.movimentacoes.length).toBeGreaterThanOrEqual(13);
    const timestamps = record.movimentacoes.map((m) => m.dataHora);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });

  it('attaches the court offset without shifting the wall clock', () => {
    expect(record.movimentacoes[0]?.dataHora).toBe('2026-06-20T11:18:14-03:00');
    expect(record.movimentacoes[0]?.descricao).toBe('Conclusos para decisão');
  });

  it('numbers them contiguously, so the primary key is dense', () => {
    expect(record.movimentacoes.map((m) => m.seq)).toEqual(record.movimentacoes.map((_, i) => i));
  });

  it('deduplicates the same movement rendered twice', () => {
    const keys = record.movimentacoes.map((m) => `${m.dataHora}|${m.descricao}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('promotes the newest movement to the summary field', () => {
    expect(record.ultimaMovimentacao?.dataHora).toBe(record.movimentacoes[0]?.dataHora);
  });
});

describe('documents', () => {
  it('finds both attachments with the id pair their PDFs need', () => {
    // Measured in the reconnaissance: these exact pairs drive reportReciboPDF.seam.
    expect(record.documentos).toHaveLength(2);
    expect(record.documentos.map((d) => [d.idDoc, d.idBin])).toEqual([
      ['3469065', '3453502'],
      ['7222997', '7127696'],
    ]);
  });

  it('reads the document type from the row, not from the generic link label', () => {
    // Every link says "Visualizar documentos"; the type is in the row text after the timestamp.
    for (const doc of record.documentos) {
      expect(doc.tipo).toBe('Acórdão');
      expect(doc.tipo).not.toContain('Visualizar');
    }
  });

  it('reads when each document was attached', () => {
    expect(record.documentos[1]?.juntadoEm).toBe('2026-05-11T00:36:17-03:00');
  });

  it('handles a case with no documents at all', () => {
    // The ids are what identify a document, not the endpoint name, so those are what go.
    const stripped = detailHtml.replace(/idBin/g, 'idOutro');
    expect(parseDetail(stripped, listed, ctx).documentos).toHaveLength(0);
  });
});

describe('record metadata', () => {
  it('carries the partition range that listed it, not a date of its own', () => {
    expect(record.dataAutuacao).toEqual({ ini: '2024-05-15', fim: '2024-05-15' });
  });

  it('records where it came from', () => {
    expect(record.fonte.detailUrl).toBe(ctx.detailUrl);
    expect(record.state).toBe('DETAILED');
    expect(record.detailedAt).toBe(ctx.now);
    expect(record.listedAt).toBe(listed.listedAt);
  });

  it('hashes the case, not the moment it was scraped', () => {
    const later = parseDetail(detailHtml, listed, { ...ctx, now: '2027-01-01T00:00:00-03:00' });
    expect(later.contentHash).toBe(record.contentHash);
  });

  it('changes the hash when the case changes', () => {
    // The page stores accents as HTML entities, so the raw text is `Gab VICE-PRESID&Ecirc;NCIA`.
    const changed = detailHtml.replace('Gab VICE-PRESID&Ecirc;NCIA', 'Gab OUTRO GABINETE');
    expect(changed).not.toBe(detailHtml);
    expect(parseDetail(changed, listed, ctx).contentHash).not.toBe(record.contentHash);
  });
});

describe('canaries', () => {
  it('C-7: a page missing its labels stops the item rather than storing a hollow record', () => {
    const gutted = detailHtml.replace(/propertyView/g, 'somethingElse');
    try {
      parseDetail(gutted, listed, ctx);
      throw new Error('expected C-7 to trip');
    } catch (error) {
      expect(error).toBeInstanceOf(SiteChangedError);
      expect((error as SiteChangedError).canaryId).toBe('C-7');
    }
  });

  it('C-6: a mojibake field stops the item rather than storing corruption', () => {
    const damaged = detailHtml.replace('TRF5', 'TRFÃ‡5');
    try {
      parseDetail(damaged, listed, ctx);
      throw new Error('expected C-6 to trip');
    } catch (error) {
      expect((error as SiteChangedError).canaryId).toBe('C-6');
    }
  });

  it('C-10: the load balancer rejection page is not parsed as a case', () => {
    try {
      parseDetail('<html><title>Requisição - Rejeitada</title></html>', listed, ctx);
      throw new Error('expected C-10 to trip');
    } catch (error) {
      expect((error as SiteChangedError).canaryId).toBe('C-10');
    }
  });
});
