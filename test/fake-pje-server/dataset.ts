/**
 * A synthetic court dataset, generated deterministically from a seed.
 *
 * The distribution is the point. A uniform dataset would let a broken partitioner look correct,
 * so the days are shaped to hit every branch of the coverage algorithm on purpose:
 *
 *   · **empty days** — the cheap prune that keeps a wide root affordable;
 *   · **days just under the cap** (29) — must resolve in one query, not split;
 *   · **days exactly at the cap** (30) — must split even when the site omits its banner;
 *   · **days over the cap** (31, 120) — must fall through to the class axis;
 *   · **one day whose single class exceeds the cap** — must be declared a `GAP`, with
 *     arithmetic, because no axis can divide it further. This is the case the phase-0 spike
 *     proved has no third axis available, and the one an honest report has to admit to.
 *
 * Determinism matters as much as the shape: the same seed must produce the same dataset on every
 * machine, so a failing completeness assertion is reproducible rather than a story about luck.
 */

export interface SyntheticCase {
  idOrigem: string;
  numero: string;
  classe: string;
  sigla: string;
  assunto: string;
  /** `YYYY-MM-DD`; the axis the whole crawl partitions on. */
  dataAutuacao: string;
  parteAtiva: string;
  partePassiva: string;
  ultimaMovimentacao: { descricao: string; dataHora: string };
  documentos: { idDoc: string; idBin: string; tipo: string; juntadoEm: string }[];
}

export const CLASSES = [
  'APELAÇÃO CÍVEL',
  'AGRAVO DE INSTRUMENTO',
  'MANDADO DE SEGURANÇA CÍVEL',
  'PROCEDIMENTO COMUM CÍVEL',
  'HABEAS CORPUS CRIMINAL',
  'REMESSA NECESSÁRIA CÍVEL',
] as const;

const SIGLAS: Record<string, string> = {
  'APELAÇÃO CÍVEL': 'ApCiv',
  'AGRAVO DE INSTRUMENTO': 'AgIns',
  'MANDADO DE SEGURANÇA CÍVEL': 'MSCiv',
  'PROCEDIMENTO COMUM CÍVEL': 'PrCom',
  'HABEAS CORPUS CRIMINAL': 'HCCrim',
  'REMESSA NECESSÁRIA CÍVEL': 'RemNec',
};

/** A small deterministic PRNG. `Math.random` would make a failure impossible to reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DatasetOptions {
  seed?: number;
  /** First day of the generated range, inclusive. */
  start?: string;
  /** How many days to generate. */
  days?: number;
  /** The cap the fake server imposes, so the shapes can be defined relative to it. */
  cap?: number;
}

export interface Dataset {
  cases: SyntheticCase[];
  byId: Map<string, SyntheticCase>;
  byDay: Map<string, SyntheticCase[]>;
  /** The day engineered so that one class alone exceeds the cap: the designed, declared GAP. */
  gapDay: string;
  cap: number;
  range: { ini: string; fim: string };
}

const MS_PER_DAY = 86_400_000;

function addDays(iso: string, n: number): string {
  const [y = '2024', m = '01', d = '01'] = iso.split('-');
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)) + n * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * How many cases a given day gets. Cycles through a fixed pattern so that every interesting
 * shape appears repeatedly across the range rather than only once at the start.
 */
function casesOnDay(index: number, cap: number): number {
  const pattern = [0, 1, 3, cap - 1, cap, cap + 1, 7, 0, 12, cap + 90, 2, 24];
  return pattern[index % pattern.length] ?? 0;
}

export function buildDataset(options: DatasetOptions = {}): Dataset {
  const seed = options.seed ?? 20260827;
  const start = options.start ?? '2024-01-01';
  const days = options.days ?? 90;
  const cap = options.cap ?? 30;
  const random = mulberry32(seed);

  const cases: SyntheticCase[] = [];
  const byDay = new Map<string, SyntheticCase[]>();
  // Two thirds of the way in, so the tree has to descend past several levels to find it.
  const gapDay = addDays(start, Math.floor(days * 0.66));

  let nextId = 10_000;
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    const isGapDay = day === gapDay;
    const count = isGapDay ? cap + 15 : casesOnDay(i, cap);
    const onThisDay: SyntheticCase[] = [];

    for (let j = 0; j < count; j++) {
      // On the GAP day every case shares one class, so filtering by class cannot get under the
      // cap and no further axis exists. That is the situation the report must declare.
      const classe = isGapDay
        ? (CLASSES[0] ?? 'APELAÇÃO CÍVEL')
        : (CLASSES[Math.floor(random() * CLASSES.length)] ?? 'APELAÇÃO CÍVEL');
      const id = String(nextId++);
      const sequential = String(nextId % 10_000_000).padStart(7, '0');
      const year = day.slice(0, 4);
      const record: SyntheticCase = {
        idOrigem: id,
        numero: `${sequential}-${checkDigits(sequential, year)}.${year}.4.05.0000`,
        classe,
        sigla: SIGLAS[classe] ?? 'XX',
        assunto: `DIREITO TRIBUTÁRIO (14) - Assunto ${String(j % 7)} (${String(5000 + (j % 7))})`,
        dataAutuacao: day,
        parteAtiva: `PARTE ATIVA ${id} LTDA`,
        partePassiva: 'FAZENDA NACIONAL',
        ultimaMovimentacao: {
          descricao: 'Conclusos para decisão',
          dataHora: `${day} 11:18:14`,
        },
        documentos:
          j % 3 === 0
            ? []
            : [
                {
                  idDoc: `9${id}`,
                  idBin: `8${id}`,
                  tipo: 'Acórdão',
                  juntadoEm: `${day} 09:30:00`,
                },
              ],
      };
      onThisDay.push(record);
      cases.push(record);
    }

    // The site returns rows ordered by case number, and the cap cuts the tail. Sorting here is
    // what makes the truncation realistic rather than a random sample.
    onThisDay.sort((a, b) => a.numero.localeCompare(b.numero));
    byDay.set(day, onThisDay);
  }

  return {
    cases,
    byId: new Map(cases.map((c) => [c.idOrigem, c])),
    byDay,
    gapDay,
    cap,
    range: { ini: start, fim: addDays(start, days - 1) },
  };
}

/** The real mod-97 check digits, so the fake data passes the same validation as the real data. */
function checkDigits(sequencial: string, ano: string): string {
  const base = `${sequencial}${ano}405000000`;
  let remainder = 0;
  for (const ch of base) remainder = (remainder * 10 + Number(ch)) % 97;
  return String(98 - remainder).padStart(2, '0');
}
