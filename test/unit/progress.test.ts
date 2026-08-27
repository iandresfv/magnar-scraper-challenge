import { describe, expect, it } from 'vitest';
import {
  countCases,
  describeExit,
  formatDuration,
  formatEta,
  formatProgress,
  formatRate,
  renderSummary,
  type ProgressSnapshot,
} from '../../src/app/progress.js';
import { ExitCode } from '../../src/core/domain/types.js';

const snapshot = (overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot => ({
  queue: { pending: 120, leased: 4, done: 380, dead: 2, byKind: {} },
  cases: { LISTED: 40, DETAILED: 300 },
  blobs: { STORED: 60, PENDING: 90 },
  jobsRun: 380,
  elapsedMs: 380_000,
  ...overrides,
});

describe('durations', () => {
  it('reads like a clock, not like a float', () => {
    expect(formatDuration(9_000)).toBe('9s');
    expect(formatDuration(252_000)).toBe('4m 12s');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5)).toBe('0s');
  });
});

describe('counting cases', () => {
  it('counts every state, including the ones the site could not render', () => {
    // The bug this replaces: a case that failed its detail dropped out of the total, so the
    // running count went *down* as the crawl advanced.
    expect(countCases({ LISTED: 40, DETAILED: 300, DETAIL_FAILED: 47 })).toEqual({
      total: 387,
      detailed: 300,
      failed: 47,
    });
    expect(countCases({})).toEqual({ total: 0, detailed: 0, failed: 0 });
  });

  it('names the unrenderable ones in the progress line and in the summary', () => {
    const withFailures = snapshot({ cases: { LISTED: 10, DETAILED: 300, DETAIL_FAILED: 47 } });
    expect(formatProgress(withFailures)).toContain('cases 357 (300 detailed, 47 unrenderable)');
    expect(
      renderSummary({
        ...withFailures,
        runId: 'run-1',
        site: 'br-trf5',
        exitCode: ExitCode.OK,
        finished: true,
        gaps: 0,
        canary: null,
      }).join('\n'),
    ).toContain('357 found · 300 detailed · 47 the site could not render');
  });
});

describe('the progress line', () => {
  it('shows the four numbers an operator watches', () => {
    const line = formatProgress(snapshot());
    expect(line).toContain('jobs 380 done · 120 pending · 2 dead');
    expect(line).toContain('cases 340 (300 detailed)');
    expect(line).toContain('pdfs 60/150');
  });

  it('estimates the remaining time from the throughput so far', () => {
    // 380 jobs in 380 s is one per second; 124 remaining is a bit over two minutes.
    expect(formatEta(snapshot())).toBe('~2m 04s');
    expect(formatRate(snapshot())).toBe('60 jobs/min');
  });

  it('refuses to guess before there is anything to guess from', () => {
    expect(formatEta(snapshot({ jobsRun: 3, elapsedMs: 1_000 }))).toBe('—');
    expect(formatEta(snapshot({ jobsRun: 0, elapsedMs: 0 }))).toBe('—');
    expect(formatRate(snapshot({ jobsRun: 0, elapsedMs: 0 }))).toBe('warming up');
  });

  it('says done rather than estimating zero', () => {
    expect(
      formatEta(snapshot({ queue: { pending: 0, leased: 0, done: 9, dead: 0, byKind: {} } })),
    ).toBe('done');
  });
});

describe('the closing summary', () => {
  const summary = (overrides: Partial<Parameters<typeof renderSummary>[0]> = {}): string =>
    renderSummary({
      ...snapshot(),
      runId: 'run-1',
      site: 'br-trf5',
      exitCode: ExitCode.OK,
      finished: true,
      gaps: 0,
      canary: null,
      ...overrides,
    }).join('\n');

  it('reports the run, the counts and the exit code in words', () => {
    const text = summary();
    expect(text).toContain('run-1 · br-trf5 · finished');
    expect(text).toContain('340 found · 300 detailed');
    expect(text).toContain('60 stored of 150 known');
    expect(text).toContain('exit');
    expect(text).toContain('0 — the run completed');
    expect(text).toContain('none — every partition resolved below the cap');
  });

  it('says what to type next, per exit code', () => {
    expect(summary({ exitCode: ExitCode.DEAD_JOBS_REMAIN })).toContain('npm run dlq:list');
    expect(summary({ exitCode: ExitCode.INTERRUPTED, finished: false })).toContain('npm start');
    expect(summary({ exitCode: ExitCode.CANARY_FATAL, finished: false })).toContain('fixtures');
    expect(summary({ exitCode: ExitCode.BREAKER_ABORTED, finished: false })).toContain('rude');
    expect(summary({ gaps: 3 })).toContain('npm run report');
  });

  it('names the canary that stopped the run', () => {
    expect(summary({ canary: { id: 'C-4', message: 'the cap moved' } })).toContain(
      'C-4: the cap moved',
    );
  });

  it('breaks the queue down by kind when the queue knows', () => {
    const text = summary({
      queue: {
        pending: 2,
        leased: 0,
        done: 10,
        dead: 1,
        byKind: { detail: { pending: 2, dead: 1 } },
      },
    });
    expect(text).toContain('detail 2 pending/1 dead');
  });
});

describe('exit codes', () => {
  it('has a sentence for every code the process can return', () => {
    for (const code of Object.values(ExitCode)) {
      expect(describeExit(code), String(code)).not.toBe('unexpected failure');
    }
    expect(describeExit(99)).toBe('unexpected failure');
  });
});
