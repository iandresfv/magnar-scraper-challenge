import { describe, expect, it } from 'vitest';
import {
  addDays,
  brDateTimeToIso,
  brDateToIso,
  compareIsoDate,
  daysInRange,
  isContiguous,
  isValidIsoDate,
  isValidRange,
  isoToBrDate,
  isoToBrMonth,
  rangeId,
  rangesOverlap,
  splitByMidDay,
} from '../../src/core/domain/dates.js';

const OFFSET = '-03:00';

describe('brDateToIso', () => {
  it.each([
    ['15/05/2024', '2024-05-15'],
    ['01/01/1990', '1990-01-01'],
    ['29/02/2024', '2024-02-29'], // leap year
    [' 31/12/2026 ', '2026-12-31'],
  ])('parses %s', (input, expected) => {
    expect(brDateToIso(input)).toBe(expected);
  });

  it.each([
    ['31/02/2024', 'february has no 31st'],
    ['29/02/2023', 'not a leap year'],
    ['00/01/2024', 'day zero'],
    ['15/13/2024', 'month thirteen'],
    ['2024-05-15', 'iso, not the site format'],
    ['15/5/2024', 'unpadded'],
    ['', 'empty'],
  ])('rejects %s (%s)', (input) => {
    expect(brDateToIso(input)).toBeNull();
  });
});

describe('isValidIsoDate', () => {
  it.each(['2024-05-15', '2024-02-29', '1990-01-01'])('accepts %s', (v) => {
    expect(isValidIsoDate(v)).toBe(true);
  });
  it.each(['2023-02-29', '2024-13-01', '2024-00-10', '2024-5-15', 'yesterday'])(
    'rejects %s',
    (v) => {
      expect(isValidIsoDate(v)).toBe(false);
    },
  );
});

describe('round trip to the form format', () => {
  it('preserves the day', () => {
    expect(isoToBrDate('2024-05-15')).toBe('15/05/2024');
    expect(isoToBrMonth('2024-05-15')).toBe('05/2024');
    expect(brDateToIso(isoToBrDate('2024-05-15'))).toBe('2024-05-15');
  });
});

describe('brDateTimeToIso', () => {
  it('attaches the offset without shifting the wall clock', () => {
    expect(brDateTimeToIso('20/06/2026 11:18:14', OFFSET)).toBe('2026-06-20T11:18:14-03:00');
  });

  it('defaults missing seconds to zero', () => {
    expect(brDateTimeToIso('20/06/2026 11:18', OFFSET)).toBe('2026-06-20T11:18:00-03:00');
  });

  it.each([
    ['20/06/2026 25:00:00', 'hour 25'],
    ['20/06/2026 11:60:00', 'minute 60'],
    ['20/06/2026 11:18:60', 'second 60'],
    ['31/02/2026 11:18:14', 'impossible day'],
    ['20/06/2026', 'no time at all'],
  ])('rejects %s (%s)', (input) => {
    expect(brDateTimeToIso(input, OFFSET)).toBeNull();
  });

  it('produces a string Date can parse back to the same instant', () => {
    const iso = brDateTimeToIso('20/06/2026 11:18:14', OFFSET);
    expect(new Date(iso ?? '').toISOString()).toBe('2026-06-20T14:18:14.000Z');
  });
});

describe('range arithmetic', () => {
  it('counts inclusive days', () => {
    expect(daysInRange({ ini: '2024-05-15', fim: '2024-05-15' })).toBe(1);
    expect(daysInRange({ ini: '2024-05-15', fim: '2024-05-16' })).toBe(2);
    expect(daysInRange({ ini: '2024-01-01', fim: '2024-12-31' })).toBe(366); // leap year
    expect(daysInRange({ ini: '2023-01-01', fim: '2023-12-31' })).toBe(365);
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
  });

  it('validates ordering', () => {
    expect(isValidRange({ ini: '2024-01-01', fim: '2024-01-01' })).toBe(true);
    expect(isValidRange({ ini: '2024-01-02', fim: '2024-01-01' })).toBe(false);
    expect(isValidRange({ ini: 'nope', fim: '2024-01-01' })).toBe(false);
  });

  it('detects overlap and contiguity', () => {
    const a = { ini: '2024-01-01', fim: '2024-01-31' };
    expect(rangesOverlap(a, { ini: '2024-01-31', fim: '2024-02-05' })).toBe(true);
    expect(rangesOverlap(a, { ini: '2024-02-01', fim: '2024-02-05' })).toBe(false);
    expect(isContiguous(a, { ini: '2024-02-01', fim: '2024-02-05' })).toBe(true);
    expect(isContiguous(a, { ini: '2024-02-02', fim: '2024-02-05' })).toBe(false);
  });

  it('orders dates', () => {
    expect(compareIsoDate('2024-01-01', '2024-01-02')).toBeLessThan(0);
    expect(compareIsoDate('2024-01-02', '2024-01-01')).toBeGreaterThan(0);
    expect(compareIsoDate('2024-01-01', '2024-01-01')).toBe(0);
  });

  it('builds a stable id', () => {
    expect(rangeId({ ini: '2024-05-15', fim: '2024-05-15' })).toBe('2024-05-15..2024-05-15');
  });
});

describe('splitByMidDay', () => {
  it('refuses to split a single day, which is the signal to try the next axis', () => {
    expect(splitByMidDay({ ini: '2024-05-15', fim: '2024-05-15' })).toBeNull();
  });

  it.each([
    [2, '2024-01-01', '2024-01-02'],
    [3, '2024-01-01', '2024-01-03'],
    [4, '2024-01-01', '2024-01-04'],
    [365, '2023-01-01', '2023-12-31'],
    [366, '2024-01-01', '2024-12-31'],
    [13_514, '1990-01-01', '2026-12-31'], // 37 years, 9 of them leap
  ])('tiles a %i-day range exactly', (days, ini, fim) => {
    const parts = splitByMidDay({ ini, fim });
    expect(parts).not.toBeNull();
    const [left, right] = parts ?? [];
    if (left === undefined || right === undefined) throw new Error('unreachable');

    // The three properties that make the coverage argument sound.
    expect(left.ini).toBe(ini);
    expect(right.fim).toBe(fim);
    expect(isContiguous(left, right)).toBe(true);
    expect(daysInRange(left) + daysInRange(right)).toBe(days);
    expect(rangesOverlap(left, right)).toBe(false);
  });

  it('always terminates: repeated splitting reaches single days', () => {
    // A split that could return a child equal to its parent would loop forever.
    let frontier = [{ ini: '2024-01-01', fim: '2024-03-15' }];
    let iterations = 0;
    while (frontier.some((r) => daysInRange(r) > 1)) {
      if (++iterations > 100) throw new Error('did not converge');
      frontier = frontier.flatMap((r) => splitByMidDay(r) ?? [r]);
    }
    expect(frontier).toHaveLength(75);
    expect(frontier[0]?.ini).toBe('2024-01-01');
    expect(frontier.at(-1)?.fim).toBe('2024-03-15');
  });

  it('produces a gapless cover under randomised splitting', () => {
    // Deterministic pseudo-random: split some nodes and not others, then check the tiling.
    let seed = 1;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let trial = 0; trial < 50; trial++) {
      const root = { ini: '2020-01-01', fim: addDays('2020-01-01', Math.floor(next() * 400) + 1) };
      let leaves = [root];
      for (let depth = 0; depth < 6; depth++) {
        leaves = leaves.flatMap((r) => (next() < 0.6 ? (splitByMidDay(r) ?? [r]) : [r]));
      }
      const sorted = [...leaves].sort((a, b) => compareIsoDate(a.ini, b.ini));
      expect(sorted[0]?.ini).toBe(root.ini);
      expect(sorted.at(-1)?.fim).toBe(root.fim);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (prev === undefined || cur === undefined) throw new Error('unreachable');
        expect(isContiguous(prev, cur)).toBe(true);
      }
      expect(sorted.reduce((n, r) => n + daysInRange(r), 0)).toBe(daysInRange(root));
    }
  });
});
