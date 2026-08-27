/**
 * National person and company identifiers, validated and — when asked — anonymised.
 *
 * Brazil's CPF (11 digits, a natural person) and CNPJ (14 digits, a company) are the two that
 * v1.0 parses. The other kinds in `PersonIdKind` exist so the schema does not need an ALTER the
 * day a Peruvian or Colombian court is added; they are recognised by length and stored without
 * a check-digit verdict rather than being wrongly validated with Brazilian rules.
 *
 * On the data itself: these are public by Resolução 121/CNJ and the court publishes them. This
 * repository still ships no extracted data, and `--anonymize` exists so the sample report and
 * the exports can be shared without carrying anyone's tax number.
 */
import type { PersonId, PersonIdKind } from './types.js';

export function digitsOf(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** All-identical digits pass the arithmetic (`111.111.111-11`) but are never real. */
function isRepeated(digits: string): boolean {
  return new Set(digits).size === 1;
}

export function isValidCpf(raw: string): boolean {
  const d = digitsOf(raw);
  if (d.length !== 11 || isRepeated(d)) return false;
  for (const [length, position] of [
    [9, 10],
    [10, 11],
  ] as const) {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(d[i]) * (position - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== Number(d[length])) return false;
  }
  return true;
}

export function isValidCnpj(raw: string): boolean {
  const d = digitsOf(raw);
  if (d.length !== 14 || isRepeated(d)) return false;
  const weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (const offset of [0, 1]) {
    const slice = weights.slice(offset === 0 ? 1 : 0);
    let sum = 0;
    for (let i = 0; i < slice.length; i++) sum += Number(d[i]) * (slice[i] ?? 0);
    const remainder = sum % 11;
    const check = remainder < 2 ? 0 : 11 - remainder;
    if (check !== Number(d[12 + offset])) return false;
  }
  return true;
}

export function formatCpf(digits: string): string {
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

export function formatCnpj(digits: string): string {
  return (
    `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}` +
    `/${digits.slice(8, 12)}-${digits.slice(12)}`
  );
}

/**
 * Parse an identifier whose kind the document already stated (`CPF: 474.225.484-87`).
 *
 * `null` when the digit count contradicts the stated kind — that is a parser problem worth
 * surfacing, not something to coerce into a plausible-looking value.
 */
export function parsePersonId(kind: PersonIdKind, raw: string): PersonId | null {
  const digits = digitsOf(raw);
  if (digits === '') return null;

  switch (kind) {
    case 'CPF': {
      if (digits.length !== 11) return null;
      return { kind, digits, formatted: formatCpf(digits), valid: isValidCpf(digits) };
    }
    case 'CNPJ': {
      if (digits.length !== 14) return null;
      return { kind, digits, formatted: formatCnpj(digits), valid: isValidCnpj(digits) };
    }
    default: {
      // A kind from another country: stored verbatim, with no verdict rather than a wrong one.
      return { kind, digits, formatted: digits, valid: null };
    }
  }
}

/** Infer the kind from the digit count, when the document does not label it. */
export function inferPersonId(raw: string): PersonId | null {
  const digits = digitsOf(raw);
  if (digits.length === 11) return parsePersonId('CPF', digits);
  if (digits.length === 14) return parsePersonId('CNPJ', digits);
  return null;
}

/**
 * Replace the identifier with a masked form that keeps only the last two digits.
 *
 * The verdict (`valid`) survives, because it is a statement about data quality rather than about
 * a person, and the sample report is more useful for keeping it.
 */
export function anonymize(id: PersonId): PersonId {
  const tail = (id.digits ?? '').slice(-2);
  return {
    kind: id.kind,
    digits: null,
    formatted: `***${tail === '' ? '' : `-${tail}`}`,
    valid: id.valid,
  };
}
