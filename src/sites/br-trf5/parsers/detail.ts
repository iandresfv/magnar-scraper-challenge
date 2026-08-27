/**
 * Parses the case detail page into a complete `CaseRecord`.
 *
 * The page is a JSF render with a regular shape, found during the phase-0 spike:
 *
 * ```html
 * <div class="propertyView">
 *   <div class="name"><label>Data da Distribuição</label></div>
 *   <div class="value col-sm-12 ">15/05/2024</div>
 * </div>
 * ```
 *
 * Reading it label-first rather than by position matters: the fields a case carries vary (a
 * first-instance case has no `Órgão Julgador Colegiado`), so an index-based parser would quietly
 * shift every value by one on those. The labels themselves only appear as HTML entities, so
 * cheerio's decoding has to happen before any of them can be matched — which is why the
 * reconnaissance's first attempt found "5 of 9 labels" and concluded the page had changed.
 *
 * Everything that could not be parsed becomes `null` and is counted. Nothing is invented, and a
 * page missing its expected structure raises C-7 rather than returning a hollow record that would
 * pass straight through the sanity checks.
 */
import { load, type CheerioAPI } from 'cheerio';
import type {
  CaseDocument,
  CaseRecord,
  Lawyer,
  ListedCase,
  Movement,
  Party,
  PersonIdKind,
  Polo,
  Subject,
} from '../../../core/domain/types.js';
import { SiteChangedError } from '../../../core/ports/siteAdapter.js';
import { brDateTimeToIso, brDateToIso } from '../../../core/domain/dates.js';
import { normalizeCaseNumber, parseCaseNumber } from '../../../core/domain/cnj.js';
import { parsePersonId } from '../../../core/domain/personId.js';
import { cleanText, cleanTextOrNull, detectMojibake } from '../../../core/domain/text.js';
import { contentHashOf } from '../../../core/domain/hash.js';
import { WAF_REJECTION_PATTERN } from './listView.js';

export interface DetailParseContext {
  site: string;
  utcOffset: string;
  now: string;
  detailUrl: string;
  listUrl: string;
}

/** The labels a detail page is expected to carry. Fewer than half of them means C-7. */
export const EXPECTED_LABELS: readonly string[] = [
  'Número Processo',
  'Classe Judicial',
  'Assunto',
  'Jurisdição',
  'Órgão Julgador',
];

const POLO_SECTIONS: readonly { heading: RegExp; polo: Polo }[] = [
  { heading: /polo\s+ativo/i, polo: 'ATIVO' },
  { heading: /polo\s+passivo/i, polo: 'PASSIVO' },
  { heading: /outros\s+interessados|terceiro/i, polo: 'OUTROS' },
];

/**
 * `NOME - OAB RN1966 - CPF: 474.225.484-87 (ADVOGADO)`
 * `EMPRESA X LTDA - CNPJ: 08.409.021/0001-77 (APELANTE)`
 *
 * Both optional middle groups are genuinely optional: plenty of parties have neither.
 */
const PARTICIPANT =
  /^(.*?)(?:\s*-\s*OAB\s+([A-Z]{2})(\d+))?(?:\s*-\s*(CPF|CNPJ):\s*([\d./-]+))?\s*\(([^)]+)\)\s*$/;

const MOVEMENT_LINE = /^(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})\s*[-–]\s*(.+)$/;
/** `DIREITO TRIBUTÁRIO (14)` — description first, code in parentheses. */
const SUBJECT_SEGMENT = /^(.*?)\s*\((\d+)\)$/;
const DOC_IDS = /idBin=(\d+)[^"']*?idProcessoDoc=(\d+)|idProcessoDoc=(\d+)[^"']*?idBin=(\d+)/;
/**
 * `Visualizar documentos 11/05/2026 00:36:17 - Acórdão (Acórdão) …` — the timestamp, the type,
 * and the title the site repeats in parentheses. Deliberately not anchored to the end of the
 * row: the cell also carries the generic link label before it and inline scripts after it.
 */
const DOCUMENT_ROW_TITLED =
  /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})\s*[-–]\s*([^(\n]{1,120}?)\s*\(([^)\n]{0,120})\)/;
/** The same row when the site omits the parenthesised repetition of the type. */
const DOCUMENT_ROW_PLAIN =
  /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})\s*[-–]\s*([^\n]{1,80}?)(?:\s{2,}|$)/;

export function parseDetail(html: string, listed: ListedCase, ctx: DetailParseContext): CaseRecord {
  if (WAF_REJECTION_PATTERN.test(html)) {
    throw new SiteChangedError('C-10', 'the detail request was rejected by the load balancer', {
      idOrigem: listed.idOrigem,
    });
  }

  const $ = load(html);
  const fields = readPropertyViews($);
  for (const [label, value] of readBoldLabelledFields($)) {
    if (!fields.has(label)) fields.set(label, value);
  }

  const found = EXPECTED_LABELS.filter((label) => fields.has(label));
  if (found.length < Math.ceil(EXPECTED_LABELS.length / 2)) {
    throw new SiteChangedError(
      'C-7',
      `the detail page carries only ${String(found.length)} of ${String(EXPECTED_LABELS.length)} ` +
        `expected labels. Missing: ${EXPECTED_LABELS.filter((l) => !fields.has(l)).join(', ')}`,
      { idOrigem: listed.idOrigem, bytes: html.length },
    );
  }

  const numero = fields.get('Número Processo') ?? listed.numero;
  const { classe, classeCodigo } = splitClasse(fields.get('Classe Judicial') ?? listed.classe);
  const assuntos = parseSubjects(fields.get('Assunto') ?? '');
  const { partes, advogados } = parseParticipants($, ctx, listed.idOrigem);
  const movimentacoes = parseMovements($, ctx, listed.idOrigem);
  const documentos = parseDocuments($, ctx, listed.idOrigem);

  const identity = {
    site: ctx.site,
    idOrigem: listed.idOrigem,
    numero,
    numeroNorm: normalizeCaseNumber(numero),
    classe,
    classeCodigo,
    sigla: listed.sigla,
    assuntos,
    assuntoResumo: assuntos.map((a) => a.descricao).join(' - ') || listed.assuntoResumo,
    dataDistribuicao: brDateToIso(fields.get('Data da Distribuição') ?? ''),
    dataAutuacao: listed.partitionRange,
    jurisdicao: cleanTextOrNull(fields.get('Jurisdição') ?? null),
    orgaoJulgador: cleanTextOrNull(fields.get('Órgão Julgador') ?? null),
    orgaoJulgadorColegiado: cleanTextOrNull(fields.get('Órgão Julgador Colegiado') ?? null),
    endereco: cleanTextOrNull(fields.get('Endereço') ?? null),
    processoReferencia: cleanTextOrNull(fields.get('Processo referência') ?? null),
    partesResumo: listed.partesResumo,
    ultimaMovimentacao: movimentacoes[0]
      ? { descricao: movimentacoes[0].descricao, dataHora: movimentacoes[0].dataHora }
      : listed.ultimaMovimentacao,
    partes,
    advogados,
    movimentacoes,
    documentos,
  };

  assertNoMojibake(identity, listed.idOrigem);

  return {
    ...identity,
    numeroParts: parseCaseNumber(numero),
    extra: { labelsFound: found.length },
    fonte: { listUrl: ctx.listUrl, detailUrl: ctx.detailUrl },
    contentHash: contentHashOf(identity),
    state: 'DETAILED',
    listedAt: listed.listedAt,
    detailedAt: ctx.now,
  };
}

/**
 * Every `label` → `value` pair the page renders, decoded and cleaned.
 *
 * `propertyView` blocks **nest**: this page wraps `Órgão Julgador Colegiado`, `Endereço` and
 * `Órgão Julgador` inside two outer blocks that carry no label of their own. Taking the first
 * label found in each block therefore returns an empty string for the wrapper and loses the three
 * fields inside it — which is what made an earlier pass report them as `null` and look like the
 * page had changed. Only leaf blocks are read.
 */
function readPropertyViews($: CheerioAPI): Map<string, string> {
  const fields = new Map<string, string>();
  $('div.propertyView').each((_, element) => {
    const block = $(element);
    if (block.find('div.propertyView').length > 0) return; // a wrapper, not a field
    const label = cleanText(block.find('div.name label').first().text());
    const value = cleanText(block.find('div.value').first().text());
    if (label !== '' && !fields.has(label)) fields.set(label, value);
  });
  return fields;
}

/**
 * The page's *other* way of labelling a field.
 *
 * `Órgão Julgador`, `Órgão Julgador Colegiado` and `Endereço` are not rendered as
 * `name`/`value` pairs at all. They sit inside a `propertyView` whose `<label>` is empty, as:
 *
 * ```html
 * <div class="value"><b>Órgão Julgador Colegiado</b><br/>Pleno<br/><b>Endereço</b><br/>Cais…</div>
 * ```
 *
 * A parser that only knows the first shape reports all three as `null` — which looks exactly
 * like a page that changed, and is why they were briefly believed to be missing. Here the `<b>`
 * is the label and everything up to the next `<b>` is the value.
 */
function readBoldLabelledFields($: CheerioAPI): Map<string, string> {
  const fields = new Map<string, string>();
  $('div.propertyView div.value b').each((_, element) => {
    const bold = $(element);
    const label = cleanText(bold.text());
    if (label === '') return;

    let value = '';
    for (const node of bold.nextAll().addBack().nextAll().toArray()) {
      const el = $(node);
      if (el.is('b')) break;
      value += ` ${el.text()}`;
    }
    // Text nodes between the <br/> elements are siblings of the <b>, not of any element, so
    // they have to be walked directly rather than through nextAll().
    if (cleanText(value) === '') {
      let sibling = element.nextSibling;
      while (sibling !== null && sibling !== undefined) {
        const el = $(sibling);
        if (el.is('b')) break;
        value += ` ${el.text()}`;
        sibling = sibling.nextSibling;
      }
    }
    const cleaned = cleanText(value);
    if (cleaned !== '' && !fields.has(label)) fields.set(label, cleaned);
  });
  return fields;
}

/** `APELAÇÃO CÍVEL (198)` → name and code. The code is absent on some classes. */
function splitClasse(raw: string): { classe: string; classeCodigo: number | null } {
  const match = SUBJECT_SEGMENT.exec(cleanText(raw));
  if (match?.[1] === undefined) return { classe: cleanText(raw), classeCodigo: null };
  return { classe: cleanText(match[1]), classeCodigo: Number(match[2]) };
}

/**
 * `DIREITO TRIBUTÁRIO (14) - Crédito Tributário (5986) - Extinção do Crédito Tributário (5990)`
 *
 * Parsed by scanning for `description (code)` pairs rather than by splitting on ` - `, for two
 * reasons. Descriptions contain hyphens of their own, and — more importantly — **the site emits
 * malformed data here**: in the reference case the text reads
 * `… Decretação de Ofício (10548 DIREITO ADMINISTRATIVO … (9985) …`, with an unclosed parenthesis
 * where a second subject tree begins. Splitting on the separator merges two subjects into one and
 * loses a code; scanning for the pairs recovers every code the site actually stated.
 *
 * The closing parenthesis is optional in the pattern for exactly that reason. A segment with no
 * code at all keeps its text and a `null` code rather than being dropped.
 */
function parseSubjects(raw: string): Subject[] {
  const text = cleanText(raw);
  if (text === '') return [];

  const subjects: Subject[] = [];
  const pattern = /([^()]+?)\s*\((\d+)\)?/g;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    const descricao = cleanText((match[1] ?? '').replace(/^\s*-\s*/, ''));
    if (descricao === '') continue;
    subjects.push({ nivel: subjects.length, codigo: Number(match[2]), descricao });
    consumed = (match.index ?? 0) + match[0].length;
  }

  // Trailing text with no code of its own still names a subject.
  const tail = cleanText(text.slice(consumed).replace(/^\s*-\s*/, ''));
  if (tail !== '') subjects.push({ nivel: subjects.length, codigo: null, descricao: tail });

  return subjects.length > 0 ? subjects : [{ nivel: 0, codigo: null, descricao: text }];
}

/**
 * Parties and lawyers, read from the RichFaces panels.
 *
 * The sections are `<div class="rich-panel-header">Polo ativo</div>` followed by a sibling
 * `rich-panel-body`, and each participant is one `<span class="text-bold">` line:
 *
 *   `EMPRESA NOSSA SENHORA APARECIDA LTDA - CNPJ: 08.409.021/0001-77 (APELANTE)`
 *   `FULANO DE TAL - OAB RN1966 - CPF: 474.225.484-87 (ADVOGADO)`
 *
 * Lawyers are told from parties by their participation type rather than by which list they are
 * in, because the site interleaves them under the same polo.
 */
function parseParticipants(
  $: CheerioAPI,
  ctx: DetailParseContext,
  idOrigem: string,
): { partes: Party[]; advogados: Lawyer[] } {
  const partes: Party[] = [];
  const advogados: Lawyer[] = [];

  $('div.rich-panel-header').each((_, element) => {
    const header = $(element);
    const heading = cleanText(header.text());
    const section = POLO_SECTIONS.find((s) => s.heading.test(heading));
    if (section === undefined) return;

    const body = header.next('div.rich-panel-body');
    const scope = body.length > 0 ? body : header.parent();

    scope.find('span.text-bold').each((__, span) => {
      const line = cleanText($(span).text());
      const parsed = PARTICIPANT.exec(line);
      if (parsed === null) return;

      const [, nomeRaw = '', oabUf, oabNumero, docKind, docValue, tipoRaw = ''] = parsed;
      const nome = cleanText(nomeRaw);
      const tipoParticipacao = cleanText(tipoRaw);
      if (nome === '') return;

      const documento =
        docKind === undefined || docValue === undefined
          ? null
          : parsePersonId(docKind as PersonIdKind, docValue);

      // The situação column sits in the same row, when the panel renders one.
      const situacao = cleanTextOrNull($(span).closest('tr').find('td').eq(1).text());

      if (/ADVOGAD|DEFENSOR|PROCURADOR/i.test(tipoParticipacao)) {
        if (advogados.some((a) => a.nome === nome && a.polo === section.polo)) return;
        advogados.push({
          site: ctx.site,
          idOrigem,
          polo: section.polo,
          ordem: advogados.filter((a) => a.polo === section.polo).length,
          nome,
          registro:
            oabUf === undefined || oabNumero === undefined
              ? null
              : { uf: oabUf, numero: oabNumero },
          documento,
          situacao,
        });
      } else {
        if (partes.some((p) => p.nome === nome && p.polo === section.polo)) return;
        partes.push({
          site: ctx.site,
          idOrigem,
          polo: section.polo,
          ordem: partes.filter((p) => p.polo === section.polo).length,
          nome,
          tipoParticipacao,
          documento,
          situacao,
        });
      }
    });
  });

  return { partes, advogados };
}

function parseMovements($: CheerioAPI, ctx: DetailParseContext, idOrigem: string): Movement[] {
  const movements: Movement[] = [];
  const seen = new Set<string>();

  // The movement list is rendered as rows of `dd/MM/yyyy HH:mm:ss - descrição`. Scanning for the
  // shape rather than for a container id survives the container being renamed.
  $('td, li, div').each((_, element) => {
    const text = cleanText($(element).text());
    const match = MOVEMENT_LINE.exec(text);
    if (match?.[1] === undefined || match[2] === undefined) return;
    const dataHora = brDateTimeToIso(match[1], ctx.utcOffset);
    if (dataHora === null) return;
    const descricao = cleanText(match[2]);
    const key = `${dataHora}|${descricao}`;
    if (seen.has(key)) return;
    seen.add(key);
    movements.push({ site: ctx.site, idOrigem, seq: 0, dataHora, descricao });
  });

  // Newest first, which is the order the site shows and the order a reader expects.
  movements.sort((a, b) => b.dataHora.localeCompare(a.dataHora));
  return movements.map((m, seq) => ({ ...m, seq }));
}

/**
 * The documents attached to the case, with the ids their PDFs are fetched by.
 *
 * The pair `(idBin, idProcessoDoc)` comes from the receipt URL the row's popup carries:
 * `…/reportReciboPDF.seam?idBin=7127696&idProcessoDoc=7222997&idProcessoTrf=16730`. That pair is
 * the whole reason the PDF pipeline can be decoupled from the detail pipeline — it needs no
 * session token.
 *
 * The row reads `Visualizar documentos 11/05/2026 00:36:17 - Acórdão (Acórdão)`, so the type is
 * the text after the timestamp rather than the link's own label (which is the same generic
 * "Visualizar documentos" on every row).
 */
function parseDocuments($: CheerioAPI, ctx: DetailParseContext, idOrigem: string): CaseDocument[] {
  const documents: CaseDocument[] = [];
  const seen = new Set<string>();

  $('a[onclick], a[href]').each((_, element) => {
    const raw = `${$(element).attr('onclick') ?? ''} ${$(element).attr('href') ?? ''}`;
    const url = raw.replace(/\\x2D/gi, '-').replace(/&amp;/g, '&');
    const match = DOC_IDS.exec(url);
    if (match === null) return;
    const idDoc = match[2] ?? match[3];
    const idBin = match[1] ?? match[4] ?? null;
    if (idDoc === undefined || seen.has(idDoc)) return;
    seen.add(idDoc);

    // Inline <script> content is part of `.text()`, and these rows carry two of them; stripping
    // them first keeps the type from being read out of a JavaScript function body.
    const row = $(element).closest('tr').clone();
    row.find('script').remove();
    const rowText = cleanText(row.text());
    const described = DOCUMENT_ROW_TITLED.exec(rowText) ?? DOCUMENT_ROW_PLAIN.exec(rowText);
    const juntadoEm =
      described?.[1] === undefined ? null : brDateTimeToIso(described[1], ctx.utcOffset);
    const tipo = cleanText(described?.[2] ?? '') || 'documento';

    documents.push({
      site: ctx.site,
      idOrigem,
      idDoc,
      idBin,
      tipo,
      juntadoEm,
      titulo: cleanTextOrNull(described?.[3] ?? null),
    });
  });

  return documents.sort((a, b) => a.idDoc.localeCompare(b.idDoc));
}

function assertNoMojibake(record: Record<string, unknown>, idOrigem: string): void {
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      if (detectMojibake(value)) {
        throw new SiteChangedError(
          'C-6',
          `a detail field carries a mojibake signature (${JSON.stringify(value.slice(0, 40))})`,
          { idOrigem },
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) scan(item);
    }
  };
  scan(record);
}
