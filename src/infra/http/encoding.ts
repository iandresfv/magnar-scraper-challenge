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

export type Charset = 'utf-8' | 'iso-8859-1';

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
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
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

  const fromHeader = headers === undefined ? null : charsetFromHeaders(headers);
  if (fromHeader !== null) {
    return { text: new TextDecoder(fromHeader).decode(bytes), charset: fromHeader, via: 'header' };
  }

  const fromDocument = charsetFromDocument(bytes);
  if (fromDocument !== null) {
    return {
      text: new TextDecoder(fromDocument).decode(bytes),
      charset: fromDocument,
      via: 'document',
    };
  }

  // 3. latin1 never throws: every byte maps to a code point. Last resort by construction.
  return {
    text: new TextDecoder('iso-8859-1').decode(bytes),
    charset: 'iso-8859-1',
    via: 'fallback-latin1',
  };
}

/**
 * Percent-encode a form body in a given charset.
 *
 * `URLSearchParams` is not usable here: it always emits UTF-8, with no way to ask for anything
 * else. For an ISO-8859-1 form that turns `Ç` into `%C3%87`, which the server decodes as two
 * latin1 characters and matches against nothing.
 *
 * Characters above U+00FF cannot be represented in latin1 at all. Rather than dropping them or
 * emitting a replacement byte, they are sent as UTF-8 percent-encoding — a best effort that is
 * at least recoverable, and flagged by `unrepresentable` so the caller can log it. The site's
 * own vocabulary is entirely within latin1, so this path should stay empty.
 */
export interface EncodedForm {
  body: string;
  contentType: string;
  unrepresentable: string[];
}

const UNRESERVED = /[A-Za-z0-9*\-._]/;

export function urlencodeForm(
  fields: Record<string, string>,
  charset: Charset = 'utf-8',
): EncodedForm {
  if (charset === 'utf-8') {
    return {
      body: new URLSearchParams(fields).toString(),
      contentType: 'application/x-www-form-urlencoded',
      unrepresentable: [],
    };
  }

  const unrepresentable: string[] = [];
  const encode = (value: string): string => {
    let out = '';
    for (const ch of value) {
      const code = ch.codePointAt(0) ?? 0;
      if (UNRESERVED.test(ch)) out += ch;
      else if (ch === ' ') out += '+';
      else if (code <= 0xff) out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
      else {
        unrepresentable.push(ch);
        out += encodeURIComponent(ch);
      }
    }
    return out;
  };

  return {
    body: Object.entries(fields)
      .map(([key, value]) => `${encode(key)}=${encode(value)}`)
      .join('&'),
    contentType: 'application/x-www-form-urlencoded;charset=ISO-8859-1',
    unrepresentable,
  };
}

/** The bytes of an encoded form body. Always ASCII after percent-encoding. */
export function formBodyBytes(form: EncodedForm): Uint8Array {
  return new TextEncoder().encode(form.body);
}
