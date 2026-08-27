/**
 * `npm run export` — the dataset in a format someone can open.
 *
 * Postgres is the source of truth; JSONL and CSV exist only here, at the edge, as *output*. One
 * file per entity, which keeps the relational shape intact: a reader can join `party.csv` to
 * `case.csv` on `(site, id_origem)` exactly as the database does, and nothing is flattened into a
 * denormalised sheet that quietly loses the second party of every case.
 *
 * DECISIÓN LOCAL: the architecture asks for `COPY … TO STDOUT` on the `pg` driver and `SELECT` on
 * PGlite. `COPY` through node-postgres needs the `pg-copy-streams` package, and this project pins
 * an explicitly justified dependency list; adding one for a path that runs once at the end of a
 * crawl is a poor trade. Both drivers therefore stream the same paginated `SELECT`, and the
 * formatting lives in one place — which is also why the CSV escaping is tested once and is right
 * for both. The cost is bounded: batches of `batchSize` rows, never the whole table in memory.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '../../core/domain/types.js';
import type { SqlExecutor } from '../../core/ports/sql.js';

export type ExportFormat = 'jsonl' | 'csv';

export interface ExportOptions {
  db: SqlExecutor;
  site: string;
  format: ExportFormat;
  outDir?: string;
  /** Which entities to write. Defaults to all of them. */
  only?: readonly string[];
  /** Mask CPF/CNPJ digits. Off by default: an export is the dataset, not a publication. */
  anonymize?: boolean;
  batchSize?: number;
  write?: (line: string) => void;
}

interface Entity {
  /** File name stem, and what the summary calls it. */
  name: string;
  table: string;
  /** Stable ordering, so two exports of the same data are byte-identical. */
  orderBy: string;
  /** Columns holding personal identifiers, masked under `--anonymize`. */
  sensitive?: readonly string[];
}

/**
 * Parents before children, so a reader importing the files in order never has a dangling
 * reference — the same order the foreign keys would demand.
 */
export const ENTITIES: readonly Entity[] = [
  { name: 'run', table: 'crawl_run', orderBy: 'started_at, run_id' },
  { name: 'partition', table: 'partition', orderBy: 'data_ini, id' },
  { name: 'case', table: 'case_record', orderBy: 'id_origem' },
  { name: 'subject', table: 'subject', orderBy: 'id_origem, nivel' },
  { name: 'party', table: 'party', orderBy: 'id_origem, polo, ordem', sensitive: ['doc_digitos'] },
  {
    name: 'lawyer',
    table: 'lawyer',
    orderBy: 'id_origem, polo, ordem',
    sensitive: ['doc_digitos'],
  },
  { name: 'movement', table: 'movement', orderBy: 'id_origem, seq' },
  { name: 'document', table: 'document', orderBy: 'id_origem, id_doc' },
  { name: 'blob', table: 'blob', orderBy: 'id_origem, key' },
];

export interface ExportResult {
  exitCode: number;
  files: { name: string; path: string; rows: number }[];
}

export async function exportCommand(options: ExportOptions): Promise<ExportResult> {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const outDir = options.outDir ?? 'exports';
  const batchSize = options.batchSize ?? 2_000;
  const extension = options.format === 'csv' ? 'csv' : 'jsonl';

  const wanted =
    options.only === undefined
      ? ENTITIES
      : ENTITIES.filter((entity) => options.only?.includes(entity.name) === true);

  if (wanted.length === 0) {
    write(`nothing to export: no entity matched ${JSON.stringify(options.only ?? [])}`);
    write(`known entities: ${ENTITIES.map((e) => e.name).join(', ')}`);
    return { exitCode: ExitCode.SANITY_FAILED, files: [] };
  }

  await mkdir(outDir, { recursive: true });
  const files: ExportResult['files'] = [];

  for (const entity of wanted) {
    const path = join(outDir, `${entity.name}.${extension}`);
    const rows = await writeEntity(options, entity, path, batchSize);
    files.push({ name: entity.name, path, rows });
    write(`${String(rows).padStart(7)} row(s) → ${path}`);
  }

  const total = files.reduce((sum, file) => sum + file.rows, 0);
  write(
    `exported ${String(total)} row(s) across ${String(files.length)} file(s) in ${options.format}` +
      (options.anonymize === true ? ' · identifiers masked' : ''),
  );
  return { exitCode: ExitCode.OK, files };
}

async function writeEntity(
  options: ExportOptions,
  entity: Entity,
  path: string,
  batchSize: number,
): Promise<number> {
  const columns = await columnsOf(options.db, entity.table);
  const stream = createWriteStream(path, { encoding: 'utf8' });
  let written = 0;

  try {
    if (options.format === 'csv') {
      // A BOM, because the most likely reader is a spreadsheet, and Excel reads a UTF-8 CSV
      // without one as Latin-1 — turning "APELAÇÃO" into exactly the mojibake this project
      // spends a module preventing.
      await push(stream, `\uFEFF${columns.map(csvCell).join(',')}\r\n`);
    }

    for (let offset = 0; ; offset += batchSize) {
      const { rows } = await options.db.query<Record<string, unknown>>(
        `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM juris.${entity.table}
          WHERE site = $1 ORDER BY ${entity.orderBy} LIMIT $2 OFFSET $3`,
        [options.site, batchSize, offset],
      );
      if (rows.length === 0) break;

      const masked = rows.map((row) => maskRow(row, entity, options.anonymize === true));
      await push(
        stream,
        options.format === 'csv'
          ? masked.map((row) => columns.map((c) => csvCell(row[c])).join(',')).join('\r\n') + '\r\n'
          : masked.map((row) => JSON.stringify(jsonRow(row))).join('\n') + '\n',
      );
      written += rows.length;
      if (rows.length < batchSize) break;
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }

  return written;
}

/**
 * Column names in declaration order, from the catalogue rather than from the first row — an empty
 * table still deserves a header, and a CSV whose columns depend on whether the crawl found
 * anything is not a format.
 */
async function columnsOf(db: SqlExecutor, table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'juris' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

function maskRow(
  row: Record<string, unknown>,
  entity: Entity,
  anonymize: boolean,
): Record<string, unknown> {
  if (!anonymize || entity.sensitive === undefined) return row;
  const masked = { ...row };
  for (const column of entity.sensitive) {
    const value = masked[column];
    if (typeof value === 'string' && value !== '') {
      masked[column] = `***${value.slice(-2)}`;
    }
  }
  return masked;
}

/** snake_case columns become camelCase keys, so the JSONL reads like the domain, not the schema. */
function jsonRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[camelCase(key)] = jsonValue(value);
  return out;
}

export function camelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Buffer) return value.toString('base64');
  return value;
}

/**
 * RFC 4180 in one function.
 *
 * Quotes are doubled, and any field carrying a delimiter, a quote, a newline or edge whitespace is
 * quoted — the last one because a spreadsheet strips leading spaces from an unquoted field, which
 * is a silent edit of the data.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = renderCell(value);

  return /[",\r\n]/.test(text) || text.trim() !== text ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Every SQL type this schema can produce, rendered without falling back to `[object Object]`. */
function renderCell(value: NonNullable<unknown>): string {
  if (value instanceof Date) return value.toISOString();
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    default:
      return JSON.stringify(value) ?? '';
  }
}

/** Backpressure honoured: a large export must not buffer the whole table in the process. */
function push(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}
