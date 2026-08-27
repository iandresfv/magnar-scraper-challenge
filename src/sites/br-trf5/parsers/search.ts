/**
 * Parses the A4J search response.
 *
 * This is where completeness is decided, so the interesting logic is not "read the rows" — it is
 * telling apart three states that all look like "no data" from a distance:
 *
 *   1. **A real empty result.** The grid rendered, and its footer says `resultados encontrados`
 *      with no number in front of it. The day genuinely has no cases.
 *   2. **A truncated result.** Thirty rows and a banner. The day has more than we can see, and
 *      the partition must be split.
 *   3. **The button trap.** The POST went through, returned 200, and re-rendered the *message*
 *      panel instead of the grid. Nothing was searched. Treating this as (1) would mark the
 *      range covered having looked at nothing — the single worst failure this system can have.
 *
 * The discriminator for (3) is `Ajax-Update-Ids`: a real search always re-renders
 * `fPP:processosGridPanel`. Measured, not assumed.
 *
 * `truncated` is belt and braces: the banner **or** a full page of rows. If the site ever stops
 * emitting the banner, a page at the cap still forces a split rather than silently dropping the
 * tail.
 */
import { load } from 'cheerio';
import type { ListedCase } from '../../../core/domain/types.js';
import { SiteChangedError } from '../../../core/ports/siteAdapter.js';
import { brDateTimeToIso } from '../../../core/domain/dates.js';
import { findCaseNumber } from '../../../core/domain/cnj.js';
import {
  cleanText,
  cleanTextOrNull,
  detectMojibake,
  unescapeJsString,
} from '../../../core/domain/text.js';
import { contentHashOf } from '../../../core/domain/hash.js';
import { WAF_REJECTION_PATTERN } from './listView.js';

export interface SearchParseContext {
  site: string;
  partitionId: string;
  partitionRange: { ini: string; fim: string };
  now: string;
  utcOffset: string;
  /** The cap the partition tree was built against. A different one is fatal (C-4). */
  expectedCap: number | null;
}

export interface SearchParseResult {
  rows: ListedCase[];
  truncated: boolean;
  capSeen: number | null;
  emptyMarker: boolean;
  /** What the footer said, which is the site's own count rather than ours. */
  reportedCount: number | null;
  ajaxUpdateIds: string | null;
  /** Distinct class names seen, harvested into the vocabulary. */
  classes: string[];
}

/** The grid the site re-renders on a real search. Anything else means no search happened. */
const RESULTS_PANEL = 'fPP:processosGridPanel';

const AJAX_UPDATE_IDS = /<meta name="Ajax-Update-Ids" content="([^"]*)"/;
const CAP_BANNER = /somente os (\d+) primeiros/;
/** With no results the number is simply absent, not zero. */
const COUNT_FOOTER = /<span class="text-muted">\s*(\d*)\s*resultados encontrados<\/span>/;
const ROW_ID = /^fPP:processosTable:(\d+):/;
const CA_IN_ONCLICK = /[?&]ca=([0-9a-fA-F]+)/;

export function parseSearchResponse(html: string, ctx: SearchParseContext): SearchParseResult {
  if (WAF_REJECTION_PATTERN.test(html)) {
    throw new SiteChangedError(
      'C-10',
      'the load balancer returned its rejection page with status 200 instead of search results',
      { bytes: html.length },
    );
  }

  const ajaxUpdateIds = AJAX_UPDATE_IDS.exec(html)?.[1] ?? null;
  const bannerMatch = CAP_BANNER.exec(html);
  const capSeen = bannerMatch?.[1] === undefined ? null : Number(bannerMatch[1]);
  const countMatch = COUNT_FOOTER.exec(html);
  const reportedCount =
    countMatch === null ? null : countMatch[1] === '' ? 0 : Number(countMatch[1]);

  // The button trap. A response that never touched the grid has not searched anything, and the
  // only safe reading is "this request failed", never "this range is empty".
  if (ajaxUpdateIds !== null && !ajaxUpdateIds.includes(RESULTS_PANEL) && countMatch === null) {
    throw new SiteChangedError(
      'C-5',
      `the response re-rendered "${ajaxUpdateIds}" instead of the results grid: the search never ` +
        `ran. This is the button trap — the visible submit button does not execute a search.`,
      { ajaxUpdateIds, bytes: html.length },
    );
  }

  const rows = parseRows(html, ctx);

  if (ctx.expectedCap !== null && capSeen !== null && capSeen !== ctx.expectedCap) {
    throw new SiteChangedError(
      'C-4',
      `the site now caps results at ${String(capSeen)}, not ${String(ctx.expectedCap)}. Every ` +
        `partition resolved against the old cap is unsafe, so the run stops rather than mixing them.`,
      { capSeen, expectedCap: ctx.expectedCap },
    );
  }

  const truncated =
    capSeen !== null || (ctx.expectedCap !== null && rows.length >= ctx.expectedCap);

  return {
    rows,
    truncated,
    capSeen,
    emptyMarker: reportedCount === 0 && rows.length === 0,
    reportedCount,
    ajaxUpdateIds,
    classes: [...new Set(rows.map((r) => r.classe))].filter((c) => c !== ''),
  };
}

function parseRows(html: string, ctx: SearchParseContext): ListedCase[] {
  const $ = load(html);
  /** id -> the cells that belong to it. The row id carries `idProcessoTrf` for free. */
  const byId = new Map<string, ReturnType<typeof $>[]>();

  $('td[id^="fPP:processosTable:"]').each((_, element) => {
    const id = $(element).attr('id') ?? '';
    const match = ROW_ID.exec(id);
    const idOrigem = match?.[1];
    if (idOrigem === undefined) return;
    const cells = byId.get(idOrigem) ?? [];
    cells.push($(element));
    byId.set(idOrigem, cells);
  });

  const rows: ListedCase[] = [];
  for (const [idOrigem, cells] of byId) {
    const row = buildRow($, idOrigem, cells, ctx);
    if (row !== null) rows.push(row);
  }
  // Deterministic order regardless of how cheerio walked the document.
  rows.sort((a, b) => Number(a.idOrigem) - Number(b.idOrigem));
  return rows;
}

function buildRow(
  $: ReturnType<typeof load>,
  idOrigem: string,
  cells: ReturnType<ReturnType<typeof load>>[],
  ctx: SearchParseContext,
): ListedCase | null {
  const wholeRow = cells.map((cell) => cell.text()).join('\n');
  const numero = findCaseNumber(wholeRow);
  if (numero === null) return null;

  // `ca` lives inside an onclick, JS-escaped: `...?ca=b22e\x2Dac`. Extracting it without
  // unescaping yields a token with a literal backslash in it and a 302 on every detail request.
  const onclick = cells
    .map((cell) => cell.find('a[onclick]').attr('onclick') ?? cell.attr('onclick') ?? '')
    .find((value) => value.includes('ca='));
  const ca =
    onclick === undefined ? '' : (CA_IN_ONCLICK.exec(unescapeJsString(onclick))?.[1] ?? '');

  // The class is the leading text of the description cell, before the case-number link.
  const descriptionCell = cells.find((cell) => cell.find('b.btn-block').length > 0) ?? cells[1];
  const classe = descriptionCell === undefined ? '' : cleanText(firstTextNode($, descriptionCell));
  const bold = descriptionCell?.find('b.btn-block').text() ?? '';
  const sigla = cleanTextOrNull(bold.split(/\s/)[0] ?? '');
  const assuntoResumo = cleanText(bold.split(' - ').slice(1).join(' - '));
  const partesResumo = cleanText(
    descriptionCell === undefined ? '' : lastTextNode($, descriptionCell),
  );

  const movementCell = cells.at(-1);
  const movementText = movementCell === undefined ? '' : cleanText(movementCell.text());
  const movementMatch = /^(.*?)\s*\((\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})\)\s*$/.exec(
    movementText,
  );
  const movementAt =
    movementMatch?.[2] === undefined ? null : brDateTimeToIso(movementMatch[2], ctx.utcOffset);
  const ultimaMovimentacao =
    movementMatch?.[1] === undefined || movementAt === null
      ? null
      : { descricao: cleanText(movementMatch[1]), dataHora: movementAt };

  for (const value of [classe, assuntoResumo, partesResumo, ultimaMovimentacao?.descricao ?? '']) {
    if (detectMojibake(value)) {
      throw new SiteChangedError(
        'C-6',
        `a parsed field carries a mojibake signature (${JSON.stringify(value.slice(0, 40))}). ` +
          `The response was decoded with the wrong charset.`,
        { idOrigem },
      );
    }
  }

  const identity = {
    site: ctx.site,
    idOrigem,
    numero,
    classe,
    sigla,
    assuntoResumo,
    partesResumo,
    ultimaMovimentacao,
  };

  return {
    ...identity,
    ca,
    partitionId: ctx.partitionId,
    partitionRange: ctx.partitionRange,
    // `ca` and the partition are excluded by the canonical hash: they describe this observation,
    // not the case, and including them would make every re-listing look like a change.
    contentHash: contentHashOf(identity),
    listedAt: ctx.now,
  };
}

/**
 * A DOM text node. Checked by `nodeType` rather than by comparing `type` against the string
 * `'text'`: `type` is domhandler's `ElementType` enum, and comparing an enum to a bare string is
 * the kind of thing that keeps working until the enum's backing values change.
 */
function isTextNode(node: { nodeType?: number } | undefined): boolean {
  return node?.nodeType === 3;
}

/** The text before the first child element — where the class name sits. */
function firstTextNode(
  $: ReturnType<typeof load>,
  cell: ReturnType<ReturnType<typeof load>>,
): string {
  const node = cell.contents().first();
  return node.length > 0 && isTextNode(node[0]) ? node.text() : (cell.text().split('\n')[0] ?? '');
}

/** The text after the last child element — where the party summary sits. */
function lastTextNode(
  $: ReturnType<typeof load>,
  cell: ReturnType<ReturnType<typeof load>>,
): string {
  const nodes = cell.contents().toArray();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (isTextNode(node)) {
      const text = $(node).text().trim();
      if (text !== '') return text;
    }
  }
  return '';
}
