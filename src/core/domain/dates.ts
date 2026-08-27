/**
 * Dates, with the site's timezone made explicit.
 *
 * Two kinds of value live here and they must not be confused:
 *   · `IsoDate` (`2024-05-15`) — a **calendar day**. Partition boundaries are these. A day has
 *     no time and no zone; attaching one is how a leaf silently shifts and a case falls into a
 *     neighbouring partition.
 *   · `IsoDateTime` (`2026-06-20T11:18:14-03:00`) — an **instant**, always with its offset.
 *
 * Why a fixed offset rather than a timezone library: `America/Recife` has had no daylight saving
 * since Brazil abolished it in 2019, so the offset is a constant `-03:00`. That makes this ten
 * lines of arithmetic instead of a dependency and a database of transition rules. The constant
 * lives in the site descriptor, so a court in a zone that does observe DST would need a real
 * conversion — and would say so rather than quietly being wrong.
 */
import type { DateRange, IsoDate, IsoDateTime } from './types.js';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const BR_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const BR_DATETIME = /^(\d{2})\/(\d{2})\/(\d{4})[\sT]+(\d{2}):(\d{2})(?::(\d{2}))?$/;
const MS_PER_DAY = 86_400_000;

/** True only for a real calendar day: `2024-02-31` is rejected, not silently rolled over. */
export function isValidIsoDate(value: string): value is IsoDate {
  const match = DATE_ONLY.exec(value);
  if (match === null) return false;
  const [, y = '', m = '', d = ''] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

/** `15/05/2024` to `2024-05-15`. Returns `null` for anything that is not a real day. */
export function brDateToIso(raw: string): IsoDate | null {
  const match = BR_DATE.exec(raw.trim());
  if (match === null) return null;
  const [, d = '', m = '', y = ''] = match;
  const iso = `${y}-${m}-${d}`;
  return isValidIsoDate(iso) ? iso : null;
}

/** `2024-05-15` back to the `dd/MM/yyyy` the form expects. */
export function isoToBrDate(iso: IsoDate): string {
  const [y = '', m = '', d = ''] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** The `MM/yyyy` the RichFaces calendar widget sends alongside each date field. */
export function isoToBrMonth(iso: IsoDate): string {
  const [y = '', m = ''] = iso.split('-');
  return `${m}/${y}`;
}

/**
 * `20/06/2026 11:18:14` to `2026-06-20T11:18:14-03:00`.
 *
 * The timestamp is a wall-clock reading in the court's zone; the offset is attached, never
 * applied. Converting to UTC here would lose the information that the court said "11:18".
 */
export function brDateTimeToIso(raw: string, utcOffset: string): IsoDateTime | null {
  const match = BR_DATETIME.exec(raw.trim());
  if (match === null) return null;
  const [, d = '', m = '', y = '', hh = '', mm = '', ss] = match;
  if (!isValidIsoDate(`${y}-${m}-${d}`)) return null;
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  const seconds = ss ?? '00';
  if (Number(seconds) > 59) return null;
  return `${y}-${m}-${d}T${hh}:${mm}:${seconds}${utcOffset}`;
}

/** Midnight of a calendar day in the site's zone, as an instant. */
export function isoDateToStartOfDay(iso: IsoDate, utcOffset: string): IsoDateTime {
  return `${iso}T00:00:00${utcOffset}`;
}

// ─────────────────────────── range arithmetic ───────────────────────────
//
// All of it in UTC milliseconds over date-only values. Using local time here is the classic way
// to lose a day at a DST boundary somewhere entirely unrelated to Brazil — the machine running
// the crawler.

function toUtcMs(iso: IsoDate): number {
  const [y = '0', m = '1', d = '1'] = iso.split('-');
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(iso) + days * MS_PER_DAY);
}

/** Inclusive on both ends: a single day has length 1. */
export function daysInRange(range: DateRange): number {
  return Math.floor((toUtcMs(range.fim) - toUtcMs(range.ini)) / MS_PER_DAY) + 1;
}

export function isValidRange(range: DateRange): boolean {
  return (
    isValidIsoDate(range.ini) &&
    isValidIsoDate(range.fim) &&
    toUtcMs(range.ini) <= toUtcMs(range.fim)
  );
}

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return toUtcMs(a.ini) <= toUtcMs(b.fim) && toUtcMs(b.ini) <= toUtcMs(a.fim);
}

/** True when `b` starts exactly the day after `a` ends — the tiling condition. */
export function isContiguous(a: DateRange, b: DateRange): boolean {
  return toUtcMs(b.ini) === toUtcMs(a.fim) + MS_PER_DAY;
}

export function compareIsoDate(a: IsoDate, b: IsoDate): number {
  return toUtcMs(a) - toUtcMs(b);
}

/**
 * Split a range at its midpoint into two contiguous halves.
 *
 * The invariant that matters is that the halves **exactly** tile the parent: no gap, no overlap,
 * for every length including 2 and 3 where off-by-one errors live. A range of one day cannot be
 * split and returns `null` — that is the signal for the engine to try the next axis.
 */
export function splitByMidDay(range: DateRange): [DateRange, DateRange] | null {
  const days = daysInRange(range);
  if (days < 2) return null;
  const half = Math.floor(days / 2);
  const mid = addDays(range.ini, half - 1);
  return [
    { ini: range.ini, fim: mid },
    { ini: addDays(mid, 1), fim: range.fim },
  ];
}

/** Stable, human-readable, and the same across runs: it is part of the partition id. */
export function rangeId(range: DateRange): string {
  return `${range.ini}..${range.fim}`;
}
