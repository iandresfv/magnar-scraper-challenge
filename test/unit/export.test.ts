import { describe, expect, it } from 'vitest';
import { camelCase, csvCell } from '../../src/app/commands/export.js';
import { parseCsv } from '../support/csv.js';

describe('csv escaping', () => {
  it('leaves ordinary text alone', () => {
    expect(csvCell('APELAÇÃO CÍVEL')).toBe('APELAÇÃO CÍVEL');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(false)).toBe('false');
  });

  it('writes null and undefined as an empty field, not as the word "null"', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes anything holding a delimiter, a quote or a newline', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('he said "no"')).toBe('"he said ""no"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('quotes edge whitespace, which a spreadsheet would otherwise strip', () => {
    expect(csvCell(' leading')).toBe('" leading"');
    expect(csvCell('trailing ')).toBe('"trailing "');
  });

  it('renders dates and jsonb deterministically', () => {
    expect(csvCell(new Date('2024-05-15T12:00:00.000Z'))).toBe('2024-05-15T12:00:00.000Z');
    expect(csvCell({ classe: 'a,b' })).toBe('"{""classe"":""a,b""}"');
  });

  it('survives a round trip through a reader that knows nothing about the writer', () => {
    const values = ['plain', 'a,b', 'he said "no"', 'two\nlines', ' pad ', '', 'ção'];
    const line = values.map(csvCell).join(',');
    expect(parseCsv(`${line}\r\n`).header).toEqual(values);
  });
});

describe('field names', () => {
  it('turns schema columns into domain names', () => {
    expect(camelCase('id_origem')).toBe('idOrigem');
    expect(camelCase('data_autuacao_ini')).toBe('dataAutuacaoIni');
    expect(camelCase('sha256')).toBe('sha256');
    expect(camelCase('site')).toBe('site');
  });
});
