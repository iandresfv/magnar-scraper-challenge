/**
 * The fixtures are the ground truth for every parser test, so their bytes are themselves an
 * invariant worth guarding. If someone re-saves one through an editor that guesses the charset,
 * these tests fail before any parser test does, and the failure names the real cause.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repairDoubleEncoding } from '../../scripts/fix-fixture-encoding.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'sites',
  'br-trf5',
  'fixtures',
);

/** `Â`/`Ã` followed by a UTF-8 continuation byte: the signature of a latin1 misread. */
const MOJIBAKE = /[ÂÃ][-¿]/;

const HTML_FIXTURES = [
  '01-listview-form.html',
  '02-search-response-30-truncado.html',
  '03-detalhe-processo-16730.html',
];

describe('html fixtures', () => {
  for (const name of HTML_FIXTURES) {
    describe(name, () => {
      const bytes = readFileSync(join(FIXTURES, name));

      it('is valid UTF-8', () => {
        expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
      });

      it('carries no mojibake signature', () => {
        expect(MOJIBAKE.test(bytes.toString('utf8'))).toBe(false);
      });
    });
  }

  it('keeps the legitimate Portuguese diacritics of fixture 02', () => {
    // The repair must not be measured as "zero A-tilde": A-tilde is a real letter here.
    const text = readFileSync(join(FIXTURES, '02-search-response-30-truncado.html'), 'utf8');
    expect(text).toContain('APELAÇÃO');
    expect(text).toContain('serão exibidos');
    expect(text).not.toContain('APELAÃ');
  });

  it('exposes 30 distinct case ids and the truncation banner', () => {
    const text = readFileSync(join(FIXTURES, '02-search-response-30-truncado.html'), 'utf8');
    const ids = new Set(
      [...text.matchAll(/id="fPP:processosTable:(\d+):j_id255"/g)].map((m) => m[1]),
    );
    expect(ids.size).toBe(30);
    expect(text).toMatch(/somente os (\d+) primeiros/);
  });
});

describe('pdf fixtures', () => {
  for (const name of ['04-reportPDF-16730.pdf', '05-reportReciboPDF-7222997.pdf']) {
    it(`${name} is a structurally valid pdf`, () => {
      const bytes = readFileSync(join(FIXTURES, name));
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(bytes.subarray(-2048).toString('latin1')).toContain('%%EOF');
    });
  }
});

describe('repairDoubleEncoding', () => {
  it('recovers the server bytes from a double-encoded buffer', () => {
    const original = Buffer.from('serão exibidos', 'utf8');
    const damaged = Buffer.from(original.toString('latin1'), 'utf8');
    expect(damaged.toString('utf8')).toContain('serÃ£o');

    const { buffer, repaired } = repairDoubleEncoding(damaged);
    expect(repaired).toBe(true);
    expect(buffer.equals(original)).toBe(true);
  });

  it('is idempotent: an already correct buffer is returned untouched', () => {
    const clean = Buffer.from('APELAÇÃO CÍVEL', 'utf8');
    const { buffer, repaired } = repairDoubleEncoding(clean);
    expect(repaired).toBe(false);
    expect(buffer.equals(clean)).toBe(true);
  });

  it('leaves the committed fixture alone, because it is already repaired', () => {
    const bytes = readFileSync(join(FIXTURES, '02-search-response-30-truncado.html'));
    expect(repairDoubleEncoding(bytes).repaired).toBe(false);
  });
});
