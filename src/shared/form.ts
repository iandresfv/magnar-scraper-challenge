/**
 * `application/x-www-form-urlencoded` bodies, in a charset the caller chooses.
 *
 * This lives in `shared/` rather than in the transport because a **site** decides the charset of
 * its own form, and `sites/` must not reach into `infra/`. The hexagonal test found that the
 * moment the TRF5 form builder needed it, which is what the rule is for.
 *
 * `URLSearchParams` cannot be used: it always emits UTF-8, with no way to ask for anything else.
 * For an ISO-8859-1 form that turns `Ç` into `%C3%87`, which the server decodes as two latin1
 * characters and matches against nothing — no error, no banner, just an empty result.
 */

export type FormCharset = 'utf-8' | 'iso-8859-1';

/**
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
  charset: FormCharset = 'utf-8',
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
