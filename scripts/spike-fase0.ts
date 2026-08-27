/**
 * Fase 0 spike — the questions that must be answered against the real site before a single
 * line of the engine is written.
 *
 * This is deliberately a **script** and not part of the engine: it duplicates a little
 * transport logic (a minimal cookie jar, one regex per field) precisely so that it can run
 * before the transport exists, and so that nothing it learns is smuggled into production code
 * as an unexamined assumption. What it produces is the table in `docs/spike-fase0.md` and one
 * decision: which secondary partition axis the crawler will use.
 *
 * Respect for a public court server is a hard constraint, not a preference:
 *   · a hard cap of 40 requests, enforced by the counter itself;
 *   · strictly sequential, with a pause between requests;
 *   · an identifiable User-Agent and Accept-Language, the same the reconnaissance used;
 *   · no load testing of any kind, ever.
 *
 * Usage:
 *   npx tsx scripts/spike-fase0.ts [--ca-idle-seconds 600] [--harvest-days 18] [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const BASE = 'https://pjett.trf5.jus.br';
const LIST_VIEW = `${BASE}/pjeconsulta/ConsultaPublica/listView.seam`;
const DETAIL = `${BASE}/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

/** The reconnaissance found 24 cases on this day, untruncated. It is the control measurement. */
const GOLDEN_DAY = '15/05/2024';
const MAX_REQUESTS = 40;
const DELAY_MS = 1_200;

/** The F5 answers a rejected request with status 200 and this page. Not a 403. */
const WAF_REJECTION = /Requisi[^<]*Rejeitada/i;

// ───────────────────────────── minimal transport ─────────────────────────────

/** Just enough cookie jar for one host: name -> value, last write wins. */
class TinyJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get names(): string[] {
    return [...this.cookies.keys()];
  }
}

interface Fetched {
  status: number;
  bytes: Uint8Array;
  text: string;
  charsetHeader: string | null;
  /** Which decoding branch actually produced `text`. One of the spike's questions. */
  decodedAs: 'utf-8' | 'declared' | 'latin1';
  location: string | null;
  elapsedMs: number;
  wafRejected: boolean;
}

let requestCount = 0;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(
  url: string,
  jar: TinyJar,
  init: { method?: 'GET' | 'POST'; body?: string; charset?: 'utf-8' | 'iso-8859-1' } = {},
): Promise<Fetched> {
  if (requestCount >= MAX_REQUESTS) {
    throw new Error(`request budget of ${String(MAX_REQUESTS)} exhausted — refusing to continue`);
  }
  requestCount++;
  if (requestCount > 1) await sleep(DELAY_MS);

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9',
  };
  // Measured, not guessed: an **empty** `Cookie:` header makes the F5 answer `200 OK` with a
  // "Requisição - Rejeitada" page instead of the form. It is not a 403, so a client that always
  // sets the header from an empty jar fails silently on the first request of every session.
  const cookie = jar.header();
  if (cookie !== '') headers['Cookie'] = cookie;

  if (init.body !== undefined) {
    headers['Content-Type'] =
      `application/x-www-form-urlencoded${init.charset === 'iso-8859-1' ? ';charset=ISO-8859-1' : ''}`;
    headers['X-Requested-With'] = 'XMLHttpRequest';
    headers['Referer'] = LIST_VIEW;
  }

  const started = Date.now();
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  jar.absorb(response);

  const contentType = response.headers.get('content-type');
  const charsetHeader = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase() ?? null;
  const decoded = decodeBytes(bytes, charsetHeader);

  return {
    status: response.status,
    bytes,
    text: decoded.text,
    decodedAs: decoded.via,
    charsetHeader,
    location: response.headers.get('location'),
    elapsedMs: Date.now() - started,
    wafRejected: WAF_REJECTION.test(decoded.text),
  };
}

/**
 * Decode by detection, in the order the engine will use: strict UTF-8 first, then the declared
 * charset, then latin1. Strict UTF-8 goes first on purpose — this server declares ISO-8859-1 on
 * responses whose body is genuinely UTF-8, so believing the declaration would corrupt them.
 * Which branch wins for each endpoint is one of the answers this spike exists to record.
 */
function decodeBytes(
  bytes: Uint8Array,
  declared: string | null,
): { text: string; via: Fetched['decodedAs'] } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), via: 'utf-8' };
  } catch {
    if (declared !== null && declared !== 'utf-8') {
      try {
        return { text: new TextDecoder(declared).decode(bytes), via: 'declared' };
      } catch {
        // Unknown charset label; fall through to latin1.
      }
    }
    return { text: new TextDecoder('latin1').decode(bytes), via: 'latin1' };
  }
}

/**
 * Percent-encode using latin1 bytes rather than UTF-8.
 *
 * This is the difference between a working class filter and a silent zero: the form is declared
 * ISO-8859-1 and `URLSearchParams` always emits UTF-8, so sending `APELAÇÃO CÍVEL` as UTF-8
 * makes the server read mojibake and match nothing — with no error, no banner and a perfectly
 * ordinary-looking empty result.
 */
function encodeFormLatin1(fields: Record<string, string>): string {
  const encode = (value: string): string => {
    let out = '';
    for (const ch of value) {
      const code = ch.codePointAt(0) ?? 0;
      if (/[A-Za-z0-9*\-._]/.test(ch)) out += ch;
      else if (ch === ' ') out += '+';
      else if (code <= 0xff) out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
      else out += encodeURIComponent(ch);
    }
    return out;
  };
  return Object.entries(fields)
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .join('&');
}

// ───────────────────────────── form handling ─────────────────────────────

interface FormMeta {
  action: string;
  searchActionId: string;
  viewState: string;
  captchaEnabled: boolean;
}

function parseFormMeta(html: string): FormMeta {
  if (WAF_REJECTION.test(html)) {
    throw new Error(
      'the F5 answered 200 with its "Requisição - Rejeitada" page — a WAF block, not a site change',
    );
  }
  const action = /<form id="fPP"[^>]*action="([^"]+)"/.exec(html)?.[1];
  const searchActionId =
    /executarPesquisa\s*=\s*function\(\)\{A4J\.AJAX\.Submit\('fPP',null,\{[\s\S]*?'parameters':\{'(fPP:j_id\d+)'/.exec(
      html,
    )?.[1];
  const viewState = /name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/.exec(html)?.[1];
  const captchaEnabled = !/function\s+executarReCaptcha\s*\(\)\s*\{\s*if\s*\(\s*false\s*\)/.test(
    html,
  );

  const context =
    `(${String(html.length)} chars; fPP x${String((html.match(/fPP/g) ?? []).length)}; ` +
    `title=${JSON.stringify(/<title>([^<]{0,60})/.exec(html)?.[1] ?? '-')})`;
  if (action === undefined) throw new Error(`form action not found ${context}`);
  if (searchActionId === undefined) throw new Error(`search action id not found — C-1 ${context}`);
  if (viewState === undefined) throw new Error(`ViewState not found ${context}`);
  return { action, searchActionId, viewState, captchaEnabled };
}

interface SearchOptions {
  ini: string;
  fim: string;
  classe?: string;
  numProcesso?: string;
}

function buildSearchFields(meta: FormMeta, options: SearchOptions): Record<string, string> {
  const currentDate = '08/2026';
  return {
    AJAXREQUEST: '_viewRoot',
    fPP: 'fPP',
    'fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso':
      options.numProcesso ?? '',
    mascaraProcessoReferenciaRadio: 'on',
    'fPP:j_id162:processoReferenciaInput': '',
    'fPP:dnp:nomeParte': '',
    'fPP:j_id180:nomeAdv': '',
    'fPP:j_id189:classeJudicial': options.classe ?? '',
    tipoMascaraDocumento: 'on',
    'fPP:dpDec:documentoParte': '',
    'fPP:Decoration:numeroOAB': '',
    'fPP:Decoration:estadoComboOAB': 'org.jboss.seam.ui.NoSelectionConverter.noSelectionValue',
    'fPP:Decoration:j_id223': '',
    'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate': options.ini,
    'fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate': currentDate,
    'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate': options.fim,
    'fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate': currentDate,
    autoScroll: '',
    'javax.faces.ViewState': meta.viewState,
    [meta.searchActionId]: meta.searchActionId,
    'AJAX:EVENTS_COUNT': '1',
  };
}

interface SearchOutcome {
  rows: number;
  ids: string[];
  classes: string[];
  cas: string[];
  truncated: boolean;
  capSeen: number | null;
  /** The footer count. `null` if the span was absent; `0` if present but with no number. */
  reportedCount: number | null;
  emptyMarker: boolean;
  ajaxUpdateIds: string | null;
  charsetHeader: string | null;
  decodedAs: Fetched['decodedAs'];
  bodyBytes: number;
  elapsedMs: number;
  mojibake: boolean;
}

function unescapeJs(text: string): string {
  return text
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function parseSearch(res: Fetched): SearchOutcome {
  const html = res.text;
  const ids = [
    ...new Set([...html.matchAll(/id="fPP:processosTable:(\d+):j_id\d+"/g)].map((m) => m[1] ?? '')),
  ];
  const capBanner = /somente os (\d+) primeiros/.exec(html);
  const classes = [
    ...new Set(
      [...html.matchAll(/<td[^>]*j_id257"[^>]*>\s*([^<\n]+?)\s*</g)].map((m) =>
        (m[1] ?? '').trim(),
      ),
    ),
  ].filter((c) => c !== '');
  const cas = [
    ...new Set([...html.matchAll(/[?&]ca=([0-9a-f]+)/g)].map((m) => unescapeJs(m[1] ?? ''))),
  ];

  // The footer always renders; with no results the number is simply missing:
  //   `<span class="text-muted">resultados encontrados</span>`    -> zero
  //   `<span class="text-muted">30 resultados encontrados</span>` -> thirty
  const countSpan = /<span class="text-muted">\s*(\d*)\s*resultados encontrados<\/span>/.exec(html);
  const reportedCount = countSpan === null ? null : countSpan[1] === '' ? 0 : Number(countSpan[1]);

  return {
    rows: ids.length,
    ids,
    classes,
    cas,
    truncated: capBanner !== null || ids.length >= 30,
    capSeen: capBanner?.[1] !== undefined ? Number(capBanner[1]) : null,
    reportedCount,
    emptyMarker: reportedCount === 0,
    ajaxUpdateIds: /<meta name="Ajax-Update-Ids" content="([^"]+)"/.exec(html)?.[1] ?? null,
    charsetHeader: res.charsetHeader,
    decodedAs: res.decodedAs,
    bodyBytes: res.bytes.byteLength,
    elapsedMs: res.elapsedMs,
    mojibake: /[ÂÃ][-¿]/.test(html),
  };
}

/** The labels the detail page is expected to carry, matched after unescaping entities. */
const DETAIL_LABELS = [
  'Número Processo',
  'Data da Distribuição',
  'Classe Judicial',
  'Assunto',
  'Jurisdição',
  'Órgão Julgador',
  'Endereço',
  'Processo referência',
  'Movimenta',
];

/** Minimal entity decoding: the detail page is ASCII plus named and numeric entities. */
function unescapeEntities(text: string): string {
  const named: Record<string, string> = {
    aacute: 'á',
    eacute: 'é',
    iacute: 'í',
    oacute: 'ó',
    uacute: 'ú',
    Aacute: 'Á',
    Eacute: 'É',
    Iacute: 'Í',
    Oacute: 'Ó',
    Uacute: 'Ú',
    atilde: 'ã',
    otilde: 'õ',
    Atilde: 'Ã',
    Otilde: 'Õ',
    acirc: 'â',
    ecirc: 'ê',
    ocirc: 'ô',
    Acirc: 'Â',
    Ecirc: 'Ê',
    Ocirc: 'Ô',
    ccedil: 'ç',
    Ccedil: 'Ç',
    agrave: 'à',
    Agrave: 'À',
    ordf: 'ª',
    ordm: 'º',
    middot: '·',
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
  };
  return text
    .replace(/&([a-zA-Z]+);/g, (whole, name: string) => named[name] ?? whole)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

// ───────────────────────────── the spike ─────────────────────────────

function ddmmyyyy(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${String(date.getUTCFullYear())}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'ca-idle-seconds': { type: 'string', default: '600' },
      'harvest-days': { type: 'string', default: '18' },
      json: { type: 'string' },
    },
  });
  const caIdleSeconds = Number(values['ca-idle-seconds']);
  const harvestDays = Number(values['harvest-days']);

  const jar = new TinyJar();
  const findings: Record<string, unknown> = {};
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  log(
    `spike fase 0 — budget ${String(MAX_REQUESTS)} requests, sequential, ${String(DELAY_MS)} ms apart`,
  );
  log('');

  // (0) Bootstrap ────────────────────────────────────────────────────────────
  const boot = await request(LIST_VIEW, jar);
  const meta = parseFormMeta(boot.text);
  findings['bootstrap'] = {
    status: boot.status,
    charsetHeader: boot.charsetHeader,
    decodedAs: boot.decodedAs,
    cookies: jar.names,
    searchActionId: meta.searchActionId,
    viewState: meta.viewState,
    captchaEnabled: meta.captchaEnabled,
    nonAsciiBytes: boot.bytes.some((b) => b > 0x7f),
    elapsedMs: boot.elapsedMs,
  };
  log(
    `bootstrap        status=${String(boot.status)} charset=${boot.charsetHeader ?? '-'} ` +
      `decodedAs=${boot.decodedAs} action=${meta.searchActionId} captcha=${String(meta.captchaEnabled)} ` +
      `cookies=${String(jar.names.length)} ${String(boot.elapsedMs)}ms`,
  );

  const post = async (
    options: SearchOptions,
    charset: 'utf-8' | 'iso-8859-1' = 'iso-8859-1',
  ): Promise<SearchOutcome> => {
    const fields = buildSearchFields(meta, options);
    const body =
      charset === 'iso-8859-1' ? encodeFormLatin1(fields) : new URLSearchParams(fields).toString();
    return parseSearch(
      await request(`${BASE}${meta.action}`, jar, { method: 'POST', body, charset }),
    );
  };

  // (a) The golden probe, and the charset of the A4J response ─────────────────
  const golden = await post({ ini: GOLDEN_DAY, fim: GOLDEN_DAY });
  findings['goldenProbe'] = golden;
  log(
    `golden probe     rows=${String(golden.rows)} reported=${String(golden.reportedCount)} ` +
      `truncated=${String(golden.truncated)} charset=${golden.charsetHeader ?? '-'} ` +
      `decodedAs=${golden.decodedAs} mojibake=${String(golden.mojibake)} ${String(golden.elapsedMs)}ms`,
  );

  // (b) The exact "no results" marker ────────────────────────────────────────
  const empty = await post({ ini: '01/01/1901', fim: '31/12/1901' });
  findings['emptyMarker'] = {
    rows: empty.rows,
    reportedCount: empty.reportedCount,
    emptyMarker: empty.emptyMarker,
    ajaxUpdateIds: empty.ajaxUpdateIds,
    bodyBytes: empty.bodyBytes,
  };
  log(
    `empty range      rows=${String(empty.rows)} reported=${String(empty.reportedCount)} ` +
      `marker=${String(empty.emptyMarker)} updateIds=${empty.ajaxUpdateIds ?? '-'} bytes=${String(empty.bodyBytes)}`,
  );

  // (c) Does classeJudicial filter, and under which encoding? (SUP-2, R-5) ────
  const classe = golden.classes[0] ?? 'APELAÇÃO CÍVEL';
  const asUtf8 = await post({ ini: GOLDEN_DAY, fim: GOLDEN_DAY, classe }, 'utf-8');
  const asLatin1 = await post({ ini: GOLDEN_DAY, fim: GOLDEN_DAY, classe });
  const prefix = classe.slice(0, 5);
  const asPrefix = await post({ ini: GOLDEN_DAY, fim: GOLDEN_DAY, classe: prefix });
  findings['classeAxis'] = {
    candidate: classe,
    unfilteredRows: golden.rows,
    rowsUtf8Encoded: asUtf8.rows,
    rowsLatin1Encoded: asLatin1.rows,
    prefixProbe: prefix,
    rowsPrefix: asPrefix.rows,
    filtersWhenLatin1: asLatin1.rows > 0 && asLatin1.rows < golden.rows,
    matchIsPrefix: asPrefix.rows > asLatin1.rows,
    subsetOfGolden: asLatin1.ids.every((id) => golden.ids.includes(id)),
  };
  log(
    `classe filter    "${classe}" utf8=${String(asUtf8.rows)} latin1=${String(asLatin1.rows)} ` +
      `prefix("${prefix}")=${String(asPrefix.rows)} of ${String(golden.rows)}`,
  );

  // (d) Does a partial case number filter? (would enable a CNJ-year axis) ─────
  const partial = await post({ ini: '01/01/1990', fim: '31/12/2027', numProcesso: '2024' });
  findings['cnjYearAxis'] = {
    probe: '2024',
    rows: partial.rows,
    reportedCount: partial.reportedCount,
    truncated: partial.truncated,
    filters: partial.rows > 0,
  };
  log(
    `numProcesso      probe="2024" rows=${String(partial.rows)} truncated=${String(partial.truncated)}`,
  );

  // (e) Data da Distribuição vs the filtered day (SUP-3) ──────────────────────
  const detailSample = golden.cas.slice(0, 5);
  const firstCa: string | null = detailSample[0] ?? null;
  const details: Record<string, unknown>[] = [];
  for (const [index, ca] of detailSample.entries()) {
    const res = await request(`${DETAIL}?ca=${ca}`, jar);
    const text = unescapeEntities(res.text);
    const dataDist =
      /Data da Distribuição<\/label>[\s\S]{0,200}?>\s*(\d{2}\/\d{2}\/\d{4})/.exec(text)?.[1] ??
      null;
    const labelsFound = DETAIL_LABELS.filter((label) => text.includes(label));
    details.push({
      ca: `${ca.slice(0, 8)}…`,
      status: res.status,
      redirectedTo: res.location,
      decodedAs: res.decodedAs,
      dataDistribuicao: dataDist,
      matchesFilteredDay: dataDist === GOLDEN_DAY,
      labelsFound: labelsFound.length,
      labelsMissing: DETAIL_LABELS.filter((l) => !labelsFound.includes(l)),
      elapsedMs: res.elapsedMs,
    });
    log(
      `detail ${String(index + 1)}/${String(detailSample.length)}       status=${String(res.status)} ` +
        `dataDistribuicao=${dataDist ?? '-'} labels=${String(labelsFound.length)}/${String(DETAIL_LABELS.length)} ` +
        `${String(res.elapsedMs)}ms`,
    );
  }
  findings['detailSample'] = details;

  // (f) Does a new search invalidate an older `ca`? (R-3) ─────────────────────
  await post({ ini: '01/01/2025', fim: '31/01/2025' });
  if (firstCa !== null) {
    const res = await request(`${DETAIL}?ca=${firstCa}`, jar);
    const stillValid = res.status === 200 && unescapeEntities(res.text).includes('Número Processo');
    findings['caAfterAnotherSearch'] = {
      status: res.status,
      redirectedTo: res.location,
      stillValid,
    };
    log(`ca after search  status=${String(res.status)} stillValid=${String(stillValid)}`);
  }

  // (g) Harvest the class vocabulary from spread-out days ─────────────────────
  const harvested = new Set<string>(golden.classes);
  const reserve = caIdleSeconds > 0 ? 1 : 0;
  const days = Math.min(harvestDays, Math.max(0, MAX_REQUESTS - requestCount - reserve));
  const harvestLog: Record<string, unknown>[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.UTC(2024 + (i % 3), (i * 5) % 12, ((i * 7) % 27) + 1));
    const label = ddmmyyyy(day);
    const outcome = await post({ ini: label, fim: label });
    const before = harvested.size;
    for (const value of outcome.classes) harvested.add(value);
    harvestLog.push({
      day: label,
      rows: outcome.rows,
      reportedCount: outcome.reportedCount,
      truncated: outcome.truncated,
      newClasses: harvested.size - before,
    });
    log(
      `harvest ${label} rows=${String(outcome.rows).padStart(2)} ` +
        `truncated=${String(outcome.truncated)} classes+${String(harvested.size - before)}`,
    );
  }
  findings['harvest'] = harvestLog;
  findings['daysOverCap'] = harvestLog.filter((d) => d['truncated'] === true).length;
  findings['maxRowsInADay'] = harvestLog.reduce((max, d) => Math.max(max, Number(d['rows'])), 0);

  // (f2) `ca` TTL after an idle period ───────────────────────────────────────
  if (caIdleSeconds > 0 && firstCa !== null && requestCount < MAX_REQUESTS) {
    log(`waiting ${String(caIdleSeconds)} s to measure the ca TTL…`);
    await sleep(caIdleSeconds * 1_000);
    const res = await request(`${DETAIL}?ca=${firstCa}`, jar);
    const stillValid = res.status === 200 && unescapeEntities(res.text).includes('Número Processo');
    findings['caAfterIdle'] = {
      idleSeconds: caIdleSeconds,
      status: res.status,
      redirectedTo: res.location,
      stillValid,
    };
    log(
      `ca after ${String(caIdleSeconds)}s status=${String(res.status)} stillValid=${String(stillValid)}`,
    );
  } else {
    findings['caAfterIdle'] = null;
  }

  log('');
  log(`requests used: ${String(requestCount)}/${String(MAX_REQUESTS)}`);
  log(`classes harvested: ${String(harvested.size)}`);

  const out = values.json;
  if (out !== undefined) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          startedAt: new Date().toISOString(),
          requests: requestCount,
          findings,
          harvestedClasses: [...harvested].sort(),
        },
        null,
        2,
      )}\n`,
    );
    log(`written: ${out}`);
  }
}

await main();
