import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  charsetFromDocument,
  charsetFromHeaders,
  decodeBody,
  formBodyBytes,
  urlencodeForm,
} from '../../src/infra/http/encoding.js';
import { detectMojibake } from '../../src/core/domain/text.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'sites',
  'br-trf5',
  'fixtures',
);

const latin1 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));
const headers = (contentType: string): Headers => new Headers({ 'content-type': contentType });

describe('charset detection from metadata', () => {
  it.each([
    ['text/html;charset=ISO-8859-1', 'iso-8859-1'],
    ['text/xml;charset=UTF-8', 'utf-8'],
    ['text/html; charset="utf-8"', 'utf-8'],
    ['text/html;charset=windows-1252', 'iso-8859-1'],
    ['text/html', null],
    ['text/html;charset=shift_jis', null],
  ])('reads %s from the header', (value, expected) => {
    expect(charsetFromHeaders(headers(value))).toBe(expected);
  });

  it('reads the xml declaration of an A4J envelope', () => {
    expect(charsetFromDocument(utf8('<?xml version="1.0" encoding="UTF-8"?><html>'))).toBe('utf-8');
  });

  it('reads a meta charset', () => {
    expect(charsetFromDocument(utf8('<html><head><meta charset="ISO-8859-1">'))).toBe('iso-8859-1');
  });

  it('only looks at the first kilobyte, so a body cannot lie late', () => {
    const padded = utf8(`<html>${' '.repeat(2000)}<meta charset="ISO-8859-1">`);
    expect(charsetFromDocument(padded)).toBeNull();
  });
});

describe('decodeBody', () => {
  it('decodes genuine UTF-8 as UTF-8 even when the header says ISO-8859-1', () => {
    // This is the real behaviour of the site: the A4J response used to be mislabelled, and
    // believing the label is what produced APELAÃ‡ÃƒO in the first reconnaissance.
    const result = decodeBody(utf8('APELAÇÃO CÍVEL'), headers('text/html;charset=ISO-8859-1'));
    expect(result.text).toBe('APELAÇÃO CÍVEL');
    expect(result.via).toBe('strict-utf8');
    expect(detectMojibake(result.text)).toBe(false);
  });

  it('decodes genuine latin1 using the declared charset', () => {
    const result = decodeBody(latin1('APELAÇÃO CÍVEL'), headers('text/html;charset=ISO-8859-1'));
    expect(result.text).toBe('APELAÇÃO CÍVEL');
    expect(result.via).toBe('header');
    expect(detectMojibake(result.text)).toBe(false);
  });

  it('falls back to the document declaration when the header says nothing', () => {
    const bytes = latin1('<?xml version="1.0" encoding="ISO-8859-1"?><p>ação</p>');
    const result = decodeBody(bytes, headers('text/html'));
    expect(result.via).toBe('document');
    expect(result.text).toContain('ação');
  });

  it('falls back to latin1 when nothing declares anything', () => {
    const result = decodeBody(latin1('ação'), headers('application/octet-stream'));
    expect(result.via).toBe('fallback-latin1');
    expect(result.text).toBe('ação');
  });

  it('works with no headers at all', () => {
    expect(decodeBody(utf8('olá')).text).toBe('olá');
  });

  it('round-trips both encodings of the same text to the same string', () => {
    const asUtf8 = decodeBody(utf8('São Paulo, ação'), headers('text/html;charset=UTF-8'));
    const asLatin1 = decodeBody(latin1('São Paulo, ação'), headers('text/html;charset=ISO-8859-1'));
    expect(asUtf8.text).toBe(asLatin1.text);
  });

  it('decodes the real A4J fixture with no mojibake', () => {
    const bytes = new Uint8Array(
      readFileSync(join(FIXTURES, '02-search-response-30-truncado.html')),
    );
    const result = decodeBody(bytes, headers('text/xml;charset=UTF-8'));
    expect(result.charset).toBe('utf-8');
    expect(detectMojibake(result.text)).toBe(false);
    expect(result.text).toContain('APELAÇÃO');
    expect(result.text).toContain('serão exibidos');
  });

  it('would produce mojibake if the declaration were believed blindly — the bug this prevents', () => {
    const bytes = utf8('APELAÇÃO');
    // What a naive "trust the header" implementation would do:
    const naive = new TextDecoder('iso-8859-1').decode(bytes);
    expect(detectMojibake(naive)).toBe(true);
    // What this module does instead:
    expect(detectMojibake(decodeBody(bytes, headers('text/html;charset=ISO-8859-1')).text)).toBe(
      false,
    );
  });
});

describe('urlencodeForm', () => {
  it('encodes latin1 bodies the way the ISO-8859-1 form expects', () => {
    const form = urlencodeForm({ classe: 'APELAÇÃO CÍVEL' }, 'iso-8859-1');
    // Ç is 0xC7 and Ã is 0xC3 in latin1 — one byte each, not a UTF-8 pair.
    expect(form.body).toBe('classe=APELA%C7%C3O+C%CDVEL');
    expect(form.contentType).toContain('ISO-8859-1');
    expect(form.unrepresentable).toEqual([]);
  });

  it('encodes UTF-8 bodies the standard way', () => {
    const form = urlencodeForm({ classe: 'APELAÇÃO CÍVEL' }, 'utf-8');
    expect(form.body).toBe('classe=APELA%C3%87%C3%83O+C%C3%8DVEL');
    expect(form.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('produces different bytes for the two charsets — the whole point of the parameter', () => {
    const a = urlencodeForm({ x: 'ção' }, 'iso-8859-1').body;
    const b = urlencodeForm({ x: 'ção' }, 'utf-8').body;
    expect(a).not.toBe(b);
  });

  it('reports characters that latin1 cannot represent instead of losing them silently', () => {
    const form = urlencodeForm({ x: 'a — b' }, 'iso-8859-1'); // em dash is U+2014
    expect(form.unrepresentable).toEqual(['—']);
    expect(form.body).toContain('%E2%80%94');
  });

  it('encodes the JSF field names, which contain colons', () => {
    const form = urlencodeForm({ 'fPP:j_id189:classeJudicial': 'X' }, 'iso-8859-1');
    expect(form.body).toBe('fPP%3Aj_id189%3AclasseJudicial=X');
  });

  it('keeps empty values as empty, which the form requires for unused filters', () => {
    expect(urlencodeForm({ a: '', b: 'x' }, 'iso-8859-1').body).toBe('a=&b=x');
  });

  it('produces ascii bytes after percent-encoding', () => {
    const bytes = formBodyBytes(urlencodeForm({ x: 'ção' }, 'iso-8859-1'));
    expect(bytes.every((b) => b < 0x80)).toBe(true);
  });
});
