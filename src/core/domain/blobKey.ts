/**
 * Where a PDF is stored, and under what name.
 *
 * The requirement is a *descriptive* filename: the server sends every file as `reportPDF.pdf`,
 * so the name is entirely the scraper's to build. Two properties matter more than prettiness:
 *
 *   · **Deterministic.** The same document must land on the same key in every run, or resuming
 *     would re-upload everything and `head`-before-`put` would never hit.
 *   · **Safe.** The key becomes an S3 object name and a path on disk, so anything that could
 *     escape a directory or upset a filesystem is stripped. A case number from a court is not
 *     hostile input, but a key builder that trusts its input is a bug waiting for the first
 *     court that formats numbers differently.
 *
 * Layout: `{site}/{year}/{numero}/{numero}__{tipo}[__{docId}].pdf`, e.g.
 * `br-trf5/2024/0000007-07.1985.8.20.0124/0000007-07.1985.8.20.0124__relatorio.pdf`.
 * Grouping by year keeps any single prefix listable, and grouping by case number puts a case's
 * documents together — which is what anyone browsing the bucket actually wants.
 */
import type { IsoDate } from './types.js';

/** Anything outside this set is replaced, including the separators of the layout itself. */
const UNSAFE = /[^A-Za-z0-9._-]/g;

export function sanitizeSegment(raw: string): string {
  const cleaned = raw.normalize('NFC').replace(UNSAFE, '_').replace(/_{2,}/g, '_');
  const trimmed = cleaned.replace(/^[._]+/, '').replace(/[._]+$/, '');
  return trimmed === '' ? 'unknown' : trimmed.slice(0, 120);
}

export interface BlobKeyInput {
  site: string;
  numero: string;
  /** Autuação year. Falls back to `unknown` rather than guessing, so nothing is misfiled. */
  dataAutuacaoIni: IsoDate | null;
  /** `relatorio` | `recibo` | whatever a future site calls its documents. */
  tipo: string;
  /** Present for per-document files, absent for the one-per-case cover. */
  idDoc?: string | null;
}

export function blobStorageKey(input: BlobKeyInput): string {
  const year = input.dataAutuacaoIni?.slice(0, 4) ?? 'unknown';
  const numero = sanitizeSegment(input.numero);
  const tipo = sanitizeSegment(input.tipo);
  const suffix =
    input.idDoc === null || input.idDoc === undefined ? '' : `__${sanitizeSegment(input.idDoc)}`;
  return `${sanitizeSegment(input.site)}/${sanitizeSegment(year)}/${numero}/${numero}__${tipo}${suffix}.pdf`;
}

/**
 * The logical identity of a blob inside the database: `relatorio:16730`,
 * `recibo:16730:7222997`. Distinct from the storage key on purpose — this one is stable even if
 * the storage layout is ever reorganised, and it is what the job queue deduplicates on.
 */
export function blobLogicalKey(tipo: string, idOrigem: string, idDoc?: string | null): string {
  return idDoc === null || idDoc === undefined
    ? `${tipo}:${idOrigem}`
    : `${tipo}:${idOrigem}:${idDoc}`;
}
