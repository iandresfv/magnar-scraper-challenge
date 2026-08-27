/**
 * ISO-8859-1 decoding that does not depend on how the runtime was compiled.
 *
 * `new TextDecoder('iso-8859-1')` is not portable for this: the WHATWG Encoding standard makes
 * `iso-8859-1` an alias for **windows-1252**, so bytes `0x80`–`0x9F` decode to typographic
 * characters on a full-ICU build (`0x87` becomes U+2021) and may map straight through on a
 * small-ICU one. The same bytes then produce different strings on a laptop and in CI — which is
 * how this was found, and it is exactly the kind of difference that turns into a corrupted field
 * nobody can reproduce.
 *
 * ISO-8859-1 itself has no ambiguity: byte `n` is code point `n`, for all 256 values.
 *
 * It lives in `shared/` because both the transport (decoding a response) and the blob layer
 * (reading a PDF's magic number) need it, and neither should depend on the other.
 */

/** Chunked so a multi-megabyte body cannot exceed the argument limit of `String.fromCharCode`. */
const CHUNK = 8_192;

export function decodeLatin1(bytes: Uint8Array): string {
  if (bytes.length <= CHUNK) return String.fromCharCode(...bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}
