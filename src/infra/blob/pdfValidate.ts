/**
 * PDF validation. Nothing is ever stored without passing through here.
 *
 * The rule exists because of a measured failure mode, not a hypothetical one. When the session
 * dies, `reportPDF.seam` answers `200 OK` with `text/html` — a redirect chain that ends at the
 * login page. A downloader that trusted the status code would write a 44 KB HTML file named
 * `…__relatorio.pdf`, and the corruption would only surface when a human opened it, months
 * later, having by then trusted a report that said "all PDFs downloaded".
 *
 * Four checks, cheapest first:
 *   1. `%PDF-` — the magic number. Catches HTML immediately.
 *   2. `Content-Length` versus bytes received. Catches a connection dropped mid-transfer, which
 *      is otherwise indistinguishable from a small file.
 *   3. `%%EOF` near the end. Catches a truncation the length header did not, because a
 *      truncated response can arrive with a correct-looking length when the server never sent
 *      one at all.
 *   4. A floor on size. A "PDF" of 200 bytes is an error page that happens to start correctly.
 */

export type PdfRejection = 'NOT_PDF' | 'PDF_TRUNCATED' | 'PDF_TOO_SMALL' | 'PDF_LENGTH_MISMATCH';

export interface PdfValidationOk {
  ok: true;
  bytes: number;
  version: string;
}

export interface PdfValidationFailure {
  ok: false;
  reason: PdfRejection;
  detail: string;
  bytes: number;
}

export type PdfValidation = PdfValidationOk | PdfValidationFailure;

const MAGIC = '%PDF-';
const EOF_MARKER = '%%EOF';
/** How far from the end `%%EOF` may sit. Trailing whitespace and incremental updates fit easily. */
const EOF_WINDOW = 2_048;
/** The smallest genuine PDF the site emits is ~18 KB; anything under 1 KB is an error page. */
const MIN_BYTES = 1_024;

export interface PdfValidationInput {
  bytes: Uint8Array;
  /** The `Content-Length` the server declared, when it declared one. */
  declaredLength?: number | null;
  contentType?: string | null;
}

export function validatePdf(input: PdfValidationInput): PdfValidation {
  const { bytes, declaredLength = null, contentType = null } = input;
  const size = bytes.byteLength;
  const head = latin1(bytes.subarray(0, 8));

  if (!head.startsWith(MAGIC)) {
    // Naming what it actually is makes the log line diagnosable rather than merely alarming.
    const looksHtml = /^\s*<(!doctype|html|\?xml)/i.test(latin1(bytes.subarray(0, 64)));
    return {
      ok: false,
      reason: 'NOT_PDF',
      detail: looksHtml
        ? `body is HTML, not a PDF (content-type ${contentType ?? 'unset'}) — the session is probably dead`
        : `body does not start with ${MAGIC} (first bytes: ${JSON.stringify(head)})`,
      bytes: size,
    };
  }

  if (declaredLength !== null && declaredLength !== size) {
    return {
      ok: false,
      reason: 'PDF_LENGTH_MISMATCH',
      detail: `server declared ${String(declaredLength)} bytes, received ${String(size)}`,
      bytes: size,
    };
  }

  if (size < MIN_BYTES) {
    return {
      ok: false,
      reason: 'PDF_TOO_SMALL',
      detail: `${String(size)} bytes is below the ${String(MIN_BYTES)}-byte floor for a real document`,
      bytes: size,
    };
  }

  const tail = latin1(bytes.subarray(Math.max(0, size - EOF_WINDOW)));
  if (!tail.includes(EOF_MARKER)) {
    return {
      ok: false,
      reason: 'PDF_TRUNCATED',
      detail: `no ${EOF_MARKER} in the last ${String(EOF_WINDOW)} bytes — the transfer was cut short`,
      bytes: size,
    };
  }

  return { ok: true, bytes: size, version: head.slice(MAGIC.length).trim().slice(0, 3) };
}

function latin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}
