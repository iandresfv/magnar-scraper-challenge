/**
 * The Brazilian national case number (Resolução 65/CNJ).
 *
 * ```
 * 0000007-07.1985.8.20.0124
 * │       │  │    │ │  └── unidade de origem (4)
 * │       │  │    │ └───── tribunal (2)
 * │       │  │    └─────── segmento do Judiciário (1)
 * │       │  └──────────── ano de ajuizamento (4)
 * │       └─────────────── dígito verificador (2)
 * └─────────────────────── número sequencial por unidade e ano (7)
 * ```
 *
 * The check digit is `98 - (NNNNNNN AAAA J TR OOOO mod 97)`, computed over the number with the
 * two check digits moved to the end as `00`. A failing digit is **reported, never a reason to
 * drop the record**: the source of truth is the court, and a scraper that silently discards
 * rows it dislikes is worse than one that flags them.
 */
import type { CaseNumber, CaseNumberParts } from './types.js';

export const CNJ_PATTERN = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;
const CNJ_ANCHORED = /^(\d{7})-(\d{2})\.(\d{4})\.(\d)\.(\d{2})\.(\d{4})$/;

/** First case number appearing anywhere in a blob of text. */
export function findCaseNumber(text: string): CaseNumber | null {
  return new RegExp(CNJ_PATTERN.source).exec(text)?.[0] ?? null;
}

/** Digits only — the join key across sites that format their numbers differently. */
export function normalizeCaseNumber(numero: string): string {
  return numero.replace(/\D/g, '');
}

/**
 * The mod-97 check. Uses string arithmetic because the concatenated number is 18 digits, well
 * past what a float can represent exactly — `Number('...')` would round and validate garbage.
 */
export function checkDigitOf(parts: {
  sequencial: string;
  ano: string;
  segmento: string;
  tribunal: string;
  origem: string;
}): string {
  const base = `${parts.sequencial}${parts.ano}${parts.segmento}${parts.tribunal}${parts.origem}00`;
  let remainder = 0;
  for (const ch of base) remainder = (remainder * 10 + Number(ch)) % 97;
  return String(98 - remainder).padStart(2, '0');
}

export function parseCaseNumber(numero: string): CaseNumberParts | null {
  const match = CNJ_ANCHORED.exec(numero.trim());
  if (match === null) return null;
  const [, sequencial = '', digito = '', ano = '', segmento = '', tribunal = '', origem = ''] =
    match;
  const expected = checkDigitOf({ sequencial, ano, segmento, tribunal, origem });
  return {
    numero,
    sequencial,
    digito,
    ano: Number(ano),
    segmento,
    tribunal,
    origem,
    valido: expected === digito,
  };
}

/** Human-readable segment names, for the sample report. */
const SEGMENTS: Record<string, string> = {
  '1': 'Supremo Tribunal Federal',
  '2': 'Conselho Nacional de Justiça',
  '3': 'Superior Tribunal de Justiça',
  '4': 'Justiça Federal',
  '5': 'Justiça do Trabalho',
  '6': 'Justiça Eleitoral',
  '7': 'Justiça Militar da União',
  '8': 'Justiça Estadual',
  '9': 'Justiça Militar Estadual',
};

export function segmentName(segmento: string): string | null {
  return SEGMENTS[segmento] ?? null;
}
