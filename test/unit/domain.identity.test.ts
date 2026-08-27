import { describe, expect, it } from 'vitest';
import {
  CNJ_PATTERN,
  checkDigitOf,
  findCaseNumber,
  normalizeCaseNumber,
  parseCaseNumber,
  segmentName,
} from '../../src/core/domain/cnj.js';
import {
  anonymize,
  formatCnpj,
  formatCpf,
  inferPersonId,
  isValidCnpj,
  isValidCpf,
  parsePersonId,
} from '../../src/core/domain/personId.js';
import {
  cleanText,
  cleanTextOrNull,
  detectMojibake,
  foldForComparison,
  mojibakeSamples,
  unescapeJsString,
} from '../../src/core/domain/text.js';
import { blobLogicalKey, blobStorageKey, sanitizeSegment } from '../../src/core/domain/blobKey.js';
import {
  canonicalJson,
  contentHashOf,
  sha256Base64,
  sha256Hex,
} from '../../src/core/domain/hash.js';

describe('case number', () => {
  it('parses the reconnaissance sample and decomposes it', () => {
    const parts = parseCaseNumber('0000007-07.1985.8.20.0124');
    expect(parts).toEqual({
      numero: '0000007-07.1985.8.20.0124',
      sequencial: '0000007',
      digito: '07',
      ano: 1985,
      segmento: '8',
      tribunal: '20',
      origem: '0124',
      valido: true,
    });
  });

  it('flags a bad check digit without discarding the record', () => {
    const parts = parseCaseNumber('0000007-99.1985.8.20.0124');
    expect(parts).not.toBeNull();
    expect(parts?.valido).toBe(false);
    expect(parts?.sequencial).toBe('0000007');
  });

  it('computes the check digit with string arithmetic, past float precision', () => {
    // The concatenated value is 18 digits; Number() would round it and validate nonsense.
    expect(
      checkDigitOf({
        sequencial: '0000007',
        ano: '1985',
        segmento: '8',
        tribunal: '20',
        origem: '0124',
      }),
    ).toBe('07');
  });

  it.each([
    ['00000007-07.1985.8.20.0124', 'eight-digit sequence'],
    ['0000007-07.1985.88.20.0124', 'two-digit segment'],
    ['0000007-07.1985.8.20.012', 'short origin'],
    ['not a number', 'nonsense'],
  ])('rejects %s (%s)', (input) => {
    expect(parseCaseNumber(input)).toBeNull();
  });

  it('finds a number inside surrounding text', () => {
    const text = 'ApCiv 0000007-07.1985.8.20.0124 - Multas e demais Sanções';
    expect(findCaseNumber(text)).toBe('0000007-07.1985.8.20.0124');
    expect(findCaseNumber('nothing here')).toBeNull();
    expect(CNJ_PATTERN.test(text)).toBe(true);
  });

  it('normalises to digits for cross-site joins', () => {
    expect(normalizeCaseNumber('0000007-07.1985.8.20.0124')).toBe('00000070719858200124');
  });

  it('names the judicial segment', () => {
    expect(segmentName('4')).toBe('Justiça Federal');
    expect(segmentName('8')).toBe('Justiça Estadual');
    expect(segmentName('0')).toBeNull();
  });
});

describe('CPF and CNPJ', () => {
  it('validates the CPF from the reconnaissance sample', () => {
    expect(isValidCpf('474.225.484-87')).toBe(true);
  });

  it('validates the CNPJ from the reconnaissance sample', () => {
    expect(isValidCnpj('08.409.021/0001-77')).toBe(true);
  });

  it.each(['111.111.111-11', '000.000.000-00', '123.456.789-00', '474.225.484-88'])(
    'rejects invalid CPF %s',
    (v) => {
      expect(isValidCpf(v)).toBe(false);
    },
  );

  it.each(['11.111.111/1111-11', '08.409.021/0001-78', '00.000.000/0000-00'])(
    'rejects invalid CNPJ %s',
    (v) => {
      expect(isValidCnpj(v)).toBe(false);
    },
  );

  it('formats canonically', () => {
    expect(formatCpf('47422548487')).toBe('474.225.484-87');
    expect(formatCnpj('08409021000177')).toBe('08.409.021/0001-77');
  });

  it('refuses a stated kind that contradicts the digit count', () => {
    expect(parsePersonId('CPF', '08.409.021/0001-77')).toBeNull();
    expect(parsePersonId('CNPJ', '474.225.484-87')).toBeNull();
  });

  it('infers the kind from length', () => {
    expect(inferPersonId('474.225.484-87')?.kind).toBe('CPF');
    expect(inferPersonId('08.409.021/0001-77')?.kind).toBe('CNPJ');
    expect(inferPersonId('12345')).toBeNull();
  });

  it('stores an identifier from another country without a wrong verdict', () => {
    const id = parsePersonId('RUC', '20512345678');
    expect(id?.kind).toBe('RUC');
    expect(id?.valid).toBeNull();
  });

  it('anonymises to the last two digits and keeps the quality verdict', () => {
    const id = parsePersonId('CPF', '474.225.484-87');
    if (id === null) throw new Error('unreachable');
    const masked = anonymize(id);
    expect(masked.digits).toBeNull();
    expect(masked.formatted).toBe('***-87');
    expect(masked.valid).toBe(true);
    expect(JSON.stringify(masked)).not.toContain('47422548487');
  });
});

describe('text normalisation', () => {
  it('collapses whitespace and normalises to NFC', () => {
    expect(cleanText('  APELAÇÃO   CÍVEL \n ')).toBe('APELAÇÃO CÍVEL');
    // Decomposed c + combining cedilla must hash the same as the precomposed form.
    const decomposed = 'APELAÇÃO';
    expect(cleanText(decomposed)).toBe('APELAÇÃO');
    expect(cleanText(decomposed).length).toBe('APELAÇÃO'.length);
  });

  it('turns an empty result into null', () => {
    expect(cleanTextOrNull('   ')).toBeNull();
    expect(cleanTextOrNull(null)).toBeNull();
    expect(cleanTextOrNull('x')).toBe('x');
  });

  it('detects the windows-1252 rendering of mojibake, not only the latin1 one', () => {
    // The WHATWG standard aliases `iso-8859-1` to windows-1252, so a full-ICU runtime renders
    // continuation bytes 0x80-0x9F as typographic characters. Both renderings are corruption.
    const asLatin1 = String.fromCharCode(0x41, 0xc3, 0x87, 0xc3, 0x83);
    const asWindows1252 = 'A' + '\u00C3\u2021\u00C3\u0192';
    expect(detectMojibake(asLatin1)).toBe(true);
    expect(detectMojibake(asWindows1252)).toBe(true);
  });

  it('detects mojibake but not legitimate diacritics', () => {
    expect(detectMojibake('APELAÇÃO CÍVEL')).toBe(false);
    expect(detectMojibake('São Paulo, ação, coração')).toBe(false);
    const damaged = Buffer.from('APELAÇÃO', 'utf8').toString('latin1');
    expect(detectMojibake(damaged)).toBe(true);
    expect(mojibakeSamples(damaged)).not.toHaveLength(0);
  });

  it('unescapes the JS sequences the onclick attributes carry', () => {
    expect(unescapeJsString('listView.seam?ca=b22e\\x2Dac')).toBe('listView.seam?ca=b22e-ac');
    expect(unescapeJsString('a\\u002Db')).toBe('a-b');
    expect(unescapeJsString("it\\'s")).toBe("it's");
  });

  it('folds accents and case for comparison only', () => {
    expect(foldForComparison('APELAÇÃO CÍVEL')).toBe('APELACAO CIVEL');
    expect(foldForComparison('apelação  cível')).toBe(foldForComparison('APELAÇÃO CÍVEL'));
  });
});

describe('content hash', () => {
  it('is independent of key order', () => {
    expect(contentHashOf({ a: 1, b: 2 })).toBe(contentHashOf({ b: 2, a: 1 }));
    expect(contentHashOf({ x: { p: 1, q: 2 } })).toBe(contentHashOf({ x: { q: 2, p: 1 } }));
  });

  it('ignores fields that describe the scrape rather than the case', () => {
    const base = { numero: '1', classe: 'X' };
    expect(contentHashOf({ ...base, listedAt: '2026-01-01T00:00:00-03:00' })).toBe(
      contentHashOf({ ...base, listedAt: '2026-08-27T12:00:00-03:00' }),
    );
    expect(contentHashOf({ ...base, partitionId: 'a' })).toBe(
      contentHashOf({ ...base, partitionId: 'b' }),
    );
  });

  it('changes when the case actually changes', () => {
    expect(contentHashOf({ numero: '1' })).not.toBe(contentHashOf({ numero: '2' }));
  });

  it('treats undefined as absent but keeps null as a value', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: null })).toBe('{"a":1,"b":null}');
  });

  it('preserves array order, which is meaningful for movements', () => {
    expect(contentHashOf([1, 2])).not.toBe(contentHashOf([2, 1]));
  });

  it('hashes bytes in both encodings the S3 API needs', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(sha256Base64(bytes), 'base64').toString('hex')).toBe(sha256Hex(bytes));
  });
});

describe('blob keys', () => {
  it('builds a descriptive, deterministic key for a case cover', () => {
    expect(
      blobStorageKey({
        site: 'br-trf5',
        numero: '0000007-07.1985.8.20.0124',
        dataAutuacaoIni: '2024-05-15',
        tipo: 'relatorio',
      }),
    ).toBe('br-trf5/2024/0000007-07.1985.8.20.0124/0000007-07.1985.8.20.0124__relatorio.pdf');
  });

  it('appends the document id for per-document files', () => {
    expect(
      blobStorageKey({
        site: 'br-trf5',
        numero: '0000007-07.1985.8.20.0124',
        dataAutuacaoIni: '2024-05-15',
        tipo: 'recibo',
        idDoc: '7222997',
      }),
    ).toContain('__recibo__7222997.pdf');
  });

  it('is deterministic', () => {
    const input = {
      site: 'br-trf5',
      numero: '0000007-07.1985.8.20.0124',
      dataAutuacaoIni: '2024-05-15',
      tipo: 'relatorio',
    };
    expect(blobStorageKey(input)).toBe(blobStorageKey({ ...input }));
  });

  it('files an unknown year under "unknown" instead of guessing', () => {
    expect(
      blobStorageKey({ site: 's', numero: 'n', dataAutuacaoIni: null, tipo: 'relatorio' }),
    ).toBe('s/unknown/n/n__relatorio.pdf');
  });

  it.each([
    // Separators become underscores, then leading dots and underscores are trimmed off.
    ['../../etc/passwd', 'etc_passwd'],
    ['a/b', 'a_b'],
    ['APELAÇÃO CÍVEL', 'APELA_O_C_VEL'],
    ['   ', 'unknown'],
    ['', 'unknown'],
    ['...', 'unknown'],
  ])('sanitises %s', (input, expected) => {
    expect(sanitizeSegment(input)).toBe(expected);
  });

  it('never lets a traversal survive into the key', () => {
    const key = blobStorageKey({
      site: 'br-trf5',
      numero: '../../../root',
      dataAutuacaoIni: '2024-01-01',
      tipo: '../x',
    });
    expect(key).not.toContain('..');
    expect(key.split('/')).toHaveLength(4);
  });

  it('builds the logical key the queue deduplicates on', () => {
    expect(blobLogicalKey('relatorio', '16730')).toBe('relatorio:16730');
    expect(blobLogicalKey('recibo', '16730', '7222997')).toBe('recibo:16730:7222997');
  });
});
