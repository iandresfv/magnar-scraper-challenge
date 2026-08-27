/**
 * Charset detection, in both directions.
 *
 * This site is a case study in why "just use UTF-8" is not a strategy. Measured, on the same
 * host, on the same day (`docs/spike-fase0.md` §3):
 *
 *   GET  listView.seam   declares ISO-8859-1  and means it   (real latin1 bytes)
 *   POST A4J response    declares UTF-8       and means it
 *   GET  detail page     declares ISO-8859-1  and means it
 *
 * and the reconnaissance had previously caught the same server declaring ISO-8859-1 over a body
 * that was genuinely UTF-8. So neither "believe the header" nor "assume UTF-8" is safe.
 *
 * **Downward** (responses) the order is: strict UTF-8 → the declared charset → the document's own
 * `<?xml>`/`<meta>` declaration → latin1. Strict UTF-8 goes first because it is self-checking:
 * arbitrary latin1 bytes are almost never valid UTF-8, so a successful strict decode is strong
 * evidence, while a declaration is only a claim.
 *
 * **Upward** (request bodies) the rule is different and easy to get wrong: the body must be
 * encoded with the charset of **the page that served the form**, which is not the charset of the
 * response the form produces. Getting this backwards is what made the class filter silently
 * return zero rows for every accented class name — no error, no banner, just an empty result
 * indistinguishable from a day with no such cases.
 */

import { decodeLatin1 } from '../../shared/latin1.js';
import { formBodyBytes, urlencodeForm, type EncodedForm } from '../../shared/form.js';

export type Charset = 'utf-8' | 'iso-8859-1';

// Re-exported because the transport's callers reason about encoding through this module. The
// implementations live in shared/ so that sites/ can use them without reaching into infra/ —
// the hexagonal test caught exactly that when the TRF5 form builder needed them.
export { decodeLatin1, formBodyBytes, urlencodeForm };
export type { EncodedForm };

export interface DecodeResult {
  text: string;
  charset: Charset;
  /** Which rule actually decided, so a surprising result can be traced. */
  via: 'strict-utf8' | 'header' | 'document' | 'fallback-latin1';
}

const CHARSET_IN_HEADER = /charset\s*=\s*"?([\w-]+)"?/i;
/** `<?xml version="1.0" encoding="UTF-8"?>` or `<meta charset=…>` / `<meta http-equiv…>`. */
const CHARSET_IN_DOCUMENT =
  /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']|<meta[^>]+charset\s*=\s*["']?([\w-]+)/i;

function normalizeCharset(raw: string | null | undefined): Charset | null {
  if (raw === null || raw === undefined) return null;
  const lower = raw.trim().toLowerCase();
  if (lower === 'utf-8' || lower === 'utf8') return 'utf-8';
  if (
    lower === 'iso-8859-1' ||
    lower === 'latin1' ||
    lower === 'iso8859-1' ||
    lower === 'windows-1252'
  ) {
    // windows-1252 is a superset of latin1 in the printable range; treating it as latin1 is
    // wrong only for bytes 0x80-0x9F, which this site does not emit.
    return 'iso-8859-1';
  }
  return null;
}

export function charsetFromHeaders(headers: Headers): Charset | null {
  return normalizeCharset(CHARSET_IN_HEADER.exec(headers.get('content-type') ?? '')?.[1]);
}

/** Reads the declaration out of the first kilobyte, decoded as latin1 so it is always readable. */
export function charsetFromDocument(bytes: Uint8Array): Charset | null {
  const head = decodeLatin1(bytes.subarray(0, 1024));
  const match = CHARSET_IN_DOCUMENT.exec(head);
  return normalizeCharset(match?.[1] ?? match?.[2]);
}

export function decodeBody(bytes: Uint8Array, headers?: Headers): DecodeResult {
  // 1. Strict UTF-8. Self-checking, so a pass is evidence rather than a claim.
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      charset: 'utf-8',
      via: 'strict-utf8',
    };
  } catch {
    // Not UTF-8. Now a declaration is worth consulting.
  }

  const decode = (charset: Charset): string =>
    charset === 'utf-8' ? new TextDecoder('utf-8').decode(bytes) : decodeLatin1(bytes);

  const fromHeader = headers === undefined ? null : charsetFromHeaders(headers);
  if (fromHeader !== null) {
    return { text: decode(fromHeader), charset: fromHeader, via: 'header' };
  }

  const fromDocument = charsetFromDocument(bytes);
  if (fromDocument !== null) {
    return { text: decode(fromDocument), charset: fromDocument, via: 'document' };
  }

  // 3. latin1 never fails: every byte maps to a code point. Last resort by construction.
  return { text: decodeLatin1(bytes), charset: 'iso-8859-1', via: 'fallback-latin1' };
}
