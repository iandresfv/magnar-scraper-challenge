/**
 * Text cleanup, and the mojibake canary.
 *
 * Every string extracted from the site passes through here exactly once, at the parser
 * boundary. Everything downstream may assume clean text; nothing downstream re-normalises.
 *
 * The interesting part is `detectMojibake`. Decoding UTF-8 as latin1 produces text that looks
 * plausible — `APELAÃ‡ÃƒO` is still letters, it sorts, it stores, it exports. Nothing fails
 * until someone reads the data. The signature is mechanical: latin1-decoded UTF-8 always puts a
 * lead byte (`Â` U+00C2 or `Ã` U+00C3) immediately before what was a continuation byte
 * (U+0080–U+00BF), and no real Portuguese, Spanish or English text ever does that.
 */

/** `Â` or `Ã` followed by a UTF-8 continuation byte rendered as a latin1 character. */
const MOJIBAKE_PATTERN = /[ÂÃ][-¿]/;

export function detectMojibake(text: string): boolean {
  return MOJIBAKE_PATTERN.test(text);
}

/** Every mojibake occurrence, with context. Used by the report, not by the hot path. */
export function mojibakeSamples(text: string, limit = 5): string[] {
  const out: string[] = [];
  const global = new RegExp(MOJIBAKE_PATTERN.source, 'g');
  for (const match of text.matchAll(global)) {
    if (out.length >= limit) break;
    const at = match.index;
    out.push(text.slice(Math.max(0, at - 12), at + 12));
  }
  return out;
}

/**
 * Collapse whitespace, trim, normalise to NFC.
 *
 * NFC matters more than it looks: the site mixes precomposed `ç` (U+00E7) with the decomposed
 * `c` + combining cedilla in different pages. Without normalisation the same court name would
 * produce two different `content_hash` values and two rows that look identical on screen.
 */
export function cleanText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().normalize('NFC');
}

/** `cleanText`, but an empty result becomes `null` rather than `''`. */
export function cleanTextOrNull(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = cleanText(raw);
  return cleaned === '' ? null : cleaned;
}

/**
 * Undo the JavaScript string escapes the site embeds in `onclick` attributes.
 *
 * The listing writes URLs as `...listView.seam?ca=b22e\x2Dac...`, so a naive extraction yields a
 * token with a literal backslash-x-2-D in the middle and every detail request 302s.
 */
export function unescapeJsString(raw: string): string {
  return raw
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([\\'"/])/g, '$1');
}

/**
 * Fold accents and case, for comparisons only — never for storage.
 *
 * The site's class filter is accent-insensitive (`APELACAO CIVEL` matches `APELAÇÃO CÍVEL`), so
 * the vocabulary has to compare the same way or it would treat them as two classes.
 */
export function foldForComparison(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}
