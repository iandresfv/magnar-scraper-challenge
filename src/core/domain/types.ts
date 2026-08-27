/**
 * The canonical domain, shared by every site.
 *
 * Two rules shape everything here:
 *
 *   1. **`site` is part of every identity.** The system is meant to consolidate several courts
 *      across LATAM, so `(site, idOrigem)` is the key, never `idOrigem` alone. A record from
 *      TRF5 and one from a Peruvian court can sit in the same table and be told apart.
 *   2. **Every string is already clean.** By the time a value reaches these types it has been
 *      HTML-unescaped, NFC-normalised, whitespace-collapsed, trimmed and checked for mojibake.
 *      Parsers do that work; nothing downstream re-does it.
 *
 * Field names that name a Brazilian legal concept keep the Portuguese term (`polo`, `classe`,
 * `assunto`) because translating them would invent vocabulary the source documents do not use
 * and the evaluator would have to map back. Structural names are English.
 */

/** `2026-06-20T11:18:14-03:00` — always with an explicit offset, never a bare local time. */
export type IsoDateTime = string;
/** `2024-05-15` — a calendar day with no time and no zone. Partition boundaries are these. */
export type IsoDate = string;

export interface DateRange {
  ini: IsoDate;
  fim: IsoDate;
}

// ─────────────────────────── identifiers ───────────────────────────

/** Brazil's national case number: `0000007-07.1985.8.20.0124`. */
export type CaseNumber = string;

export interface CaseNumberParts {
  numero: CaseNumber;
  sequencial: string;
  digito: string;
  ano: number;
  segmento: string;
  tribunal: string;
  origem: string;
  /** Result of the mod-97 check. A false here is reported, never a reason to drop the record. */
  valido: boolean;
}

export type PersonIdKind = 'CPF' | 'CNPJ' | 'DNI' | 'RUC' | 'NIT' | 'CURP' | 'RFC';

export interface PersonId {
  kind: PersonIdKind;
  /** Digits only, no punctuation. `null` once `--anonymize` has been applied. */
  digits: string | null;
  /** Canonical presentation, e.g. `000.000.000-00`. Masked under `--anonymize`. */
  formatted: string;
  /** Check-digit validation. `null` when the format is unknown for that country. */
  valid: boolean | null;
}

export interface BarRegistration {
  /** `RN` in `OAB RN1966`. */
  uf: string;
  numero: string;
}

// ───────────────────────────── the case ────────────────────────────

export type Polo = 'ATIVO' | 'PASSIVO' | 'OUTROS';

export interface Subject {
  codigo: number | null;
  descricao: string;
  /** Depth in the subject hierarchy, 0-based, flattened in order. */
  nivel: number;
}

export interface Party {
  site: string;
  idOrigem: string;
  polo: Polo;
  ordem: number;
  nome: string;
  /** `APELANTE`, `APELADO`, … as the court writes it. */
  tipoParticipacao: string;
  documento: PersonId | null;
  situacao: string | null;
}

export interface Lawyer {
  site: string;
  idOrigem: string;
  polo: Polo;
  ordem: number;
  nome: string;
  registro: BarRegistration | null;
  documento: PersonId | null;
  situacao: string | null;
}

export interface Movement {
  site: string;
  idOrigem: string;
  seq: number;
  dataHora: IsoDateTime;
  descricao: string;
}

export interface CaseDocument {
  site: string;
  idOrigem: string;
  /** TRF5: `idProcessoDoc`. */
  idDoc: string;
  /** TRF5: `idBin`. Needed to build the receipt PDF URL; absent for some document types. */
  idBin: string | null;
  tipo: string;
  juntadoEm: IsoDateTime | null;
  titulo: string | null;
}

/** What a single row of the result list yields, before the detail page is opened. */
export interface ListedCase {
  site: string;
  /** TRF5: `idProcessoTrf`, read straight out of the `<td>` id. The dedup key. */
  idOrigem: string;
  /** Opaque session-bound token that opens the detail page. Assume it expires. */
  ca: string;
  numero: CaseNumber;
  classe: string;
  /** Short form of the class, e.g. `ApCiv`. */
  sigla: string | null;
  assuntoResumo: string;
  partesResumo: string;
  ultimaMovimentacao: { descricao: string; dataHora: IsoDateTime } | null;
  /** Which partition leaf listed it. Lets the detail job re-run that search to refresh `ca`. */
  partitionId: string;
  listedAt: IsoDateTime;
}

export type CaseState = 'LISTED' | 'DETAILED' | 'DETAIL_FAILED';

export interface CaseRecord {
  site: string;
  idOrigem: string;
  numero: CaseNumber;
  /** Digits only, for joins across sites that format their numbers differently. */
  numeroNorm: string;
  numeroParts: CaseNumberParts | null;
  classe: string;
  classeCodigo: number | null;
  sigla: string | null;
  assuntos: Subject[];
  assuntoResumo: string;
  dataDistribuicao: IsoDate | null;
  /** The leaf range that listed it, which is what completeness is argued over. */
  dataAutuacao: DateRange;
  jurisdicao: string | null;
  orgaoJulgador: string | null;
  orgaoJulgadorColegiado: string | null;
  endereco: string | null;
  processoReferencia: string | null;
  partesResumo: string;
  ultimaMovimentacao: ListedCase['ultimaMovimentacao'];
  partes: Party[];
  advogados: Lawyer[];
  movimentacoes: Movement[];
  documentos: CaseDocument[];
  /** Site-specific fields that do not deserve a column. Validated by the adapter, not by SQL. */
  extra: Record<string, unknown>;
  fonte: { listUrl: string; detailUrl: string | null };
  /** sha256 of the canonical record with timestamps excluded. Re-running writes nothing. */
  contentHash: string;
  state: CaseState;
  listedAt: IsoDateTime;
  detailedAt: IsoDateTime | null;
}

// ──────────────────────────── binaries ─────────────────────────────

export type BlobState = 'PENDING' | 'STORED' | 'FAILED' | 'SKIPPED';

/** How to ask the site for one binary. Produced by `SiteAdapter.documentsOf`. */
export interface BlobRequest {
  site: string;
  /** Stable identity: `relatorio:16730` | `recibo:16730:7222997`. */
  key: string;
  idOrigem: string;
  idDoc: string | null;
  tipo: string;
  url: string;
  headers?: Record<string, string>;
  /** Whether the request must carry the listing session's cookie jar. */
  needsSession: boolean;
}

export interface BlobRecord {
  site: string;
  key: string;
  idOrigem: string;
  idDoc: string | null;
  tipo: string;
  sourceUrl: string;
  /** `s3://bucket/…` or `file:///…`. Null until stored. */
  storageUri: string | null;
  state: BlobState;
  bytes: number | null;
  sha256: string | null;
  contentType: string | null;
  storedAt: IsoDateTime | null;
}

// ──────────────────────── crawl control ────────────────────────────

export type PartitionStatus =
  | 'PENDING'
  | 'SPLIT'
  | 'SPLIT_SECONDARY'
  | 'LEAF_DONE'
  | 'LEAF_DONE_SECONDARY'
  | 'GAP'
  | 'STALE'
  | 'FAILED';

export interface PartitionNode {
  site: string;
  /** `2024-05-15..2024-05-15` or `2024-05-15..2024-05-15|classe=APELAÇÃO CÍVEL`. */
  id: string;
  runId: string;
  parentId: string | null;
  range: DateRange;
  /** Secondary-axis constraints. Empty on a primary node. */
  facets: Record<string, string>;
  status: PartitionStatus;
  observedRows: number | null;
  truncated: boolean | null;
  /** The cap the site actually reported, parsed from its banner. Never assumed to be 30. */
  capSeen: number | null;
  attempts: number;
  lastError: string | null;
  updatedAt: IsoDateTime;
}

export interface CrawlRun {
  runId: string;
  site: string;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  root: DateRange;
  config: Record<string, unknown>;
  version: string;
  exitCode: number | null;
  summary: Record<string, unknown> | null;
}

// ───────────────────────── failure model ───────────────────────────

/**
 * Every way a request can fail, as a closed set. The classifier maps responses and exceptions
 * onto this, and the retry policy is a table keyed by it — so "what happens on a 429" has
 * exactly one answer, written in one place.
 */
export type FailureClass =
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'SESSION_LOST'
  | 'NOT_PDF'
  | 'PDF_TRUNCATED'
  | 'CLIENT_ERROR'
  | 'PARSE'
  | 'FATAL_SITE_CHANGED'
  | 'BUDGET_EXHAUSTED';

/** Process exit codes. Documented in the README and asserted by the e2e suite. */
export const ExitCode = {
  OK: 0,
  DEAD_JOBS_REMAIN: 1,
  BREAKER_ABORTED: 2,
  CANARY_FATAL: 3,
  SANITY_FAILED: 4,
  INTERRUPTED: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
