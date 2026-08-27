/**
 * Row-to-domain mapping helpers, shared by the repositories.
 *
 * There is no ORM here on purpose: nine tables do not justify one, and the SQL is part of what
 * this project is meant to demonstrate. What an ORM *would* have given for free is type-safe
 * column reading, so that is what these functions provide — narrow, explicit, and failing loudly
 * on a shape the schema says is impossible.
 */
import type { SqlRow } from '../../../core/ports/sql.js';

export function readString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`column "${column}" was expected to be text, got ${describe(value)}`);
}

export function readStringOrNull(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return readString(row, column);
}

export function readNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' || typeof value === 'bigint') return Number(value);
  throw new Error(`column "${column}" was expected to be numeric, got ${describe(value)}`);
}

export function readNumberOrNull(row: SqlRow, column: string): number | null {
  const value = row[column];
  return value === null || value === undefined ? null : readNumber(row, column);
}

export function readBooleanOrNull(row: SqlRow, column: string): boolean | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (value === 't' || value === 'true') return true;
  if (value === 'f' || value === 'false') return false;
  throw new Error(`column "${column}" was expected to be boolean, got ${describe(value)}`);
}

/**
 * `timestamptz` comes back as a `Date` from both drivers. It leaves as an ISO-8601 string with
 * an offset, because that is what the domain uses and what survives a JSON export unambiguously.
 */
export function readTimestampOrNull(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  throw new Error(`column "${column}" was expected to be a timestamp, got ${describe(value)}`);
}

export function readTimestamp(row: SqlRow, column: string): string {
  const value = readTimestampOrNull(row, column);
  if (value === null) throw new Error(`column "${column}" was unexpectedly null`);
  return value;
}

export function readJson<T>(row: SqlRow, column: string, fallback: T): T {
  const value = row[column];
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const rendered =
    typeof value === 'object'
      ? JSON.stringify(value)
      : (value as string | number | boolean).toString();
  return `${typeof value} (${rendered.slice(0, 40)})`;
}
