/**
 * What a long run says while it is running, and what it says when it stops.
 *
 * A crawl over a decade of a court's docket takes hours, and the operator watching it needs two
 * things from every line: is it moving, and how much is left. Both are computed here, away from
 * the loop, so they can be tested without waiting thirty seconds for a timer.
 *
 * The ETA is deliberately modest. Listing spawns detail work and detail spawns documents, so the
 * denominator grows while the run progresses; a confident countdown would be a lie for the first
 * half of the run. It is shown as an approximation, and only once there is enough throughput to
 * mean anything.
 */
import type { QueueStats } from '../core/ports/jobQueue.js';

export interface ProgressSnapshot {
  queue: QueueStats;
  cases: Record<string, number>;
  blobs: Record<string, number>;
  /** Jobs finished by *this* process, which is what its own throughput is measured from. */
  jobsRun: number;
  elapsedMs: number;
}

/**
 * How many cases were found, and what became of them.
 *
 * The total counts every state, `DETAIL_FAILED` included. Leaving it out made the running total
 * *shrink* as a crawl progressed — a case the site cannot render is still a case that was found,
 * and a counter that goes backwards is a counter nobody believes.
 */
export function countCases(cases: Record<string, number>): {
  total: number;
  detailed: number;
  failed: number;
} {
  return {
    total: Object.values(cases).reduce((sum, n) => sum + n, 0),
    detailed: cases['DETAILED'] ?? 0,
    failed: cases['DETAIL_FAILED'] ?? 0,
  };
}

export function formatProgress(snapshot: ProgressSnapshot): string {
  const { queue, cases, blobs } = snapshot;
  const counted = countCases(cases);
  const storedDocs = blobs['STORED'] ?? 0;
  const knownDocs = storedDocs + (blobs['PENDING'] ?? 0);

  return [
    `jobs ${String(queue.done)} done · ${String(queue.pending)} pending · ${String(queue.dead)} dead`,
    `cases ${String(counted.total)} (${String(counted.detailed)} detailed` +
      `${counted.failed === 0 ? '' : `, ${String(counted.failed)} unrenderable`})`,
    `pdfs ${String(storedDocs)}/${String(knownDocs)}`,
    `${formatRate(snapshot)} · eta ${formatEta(snapshot)}`,
  ].join(' · ');
}

/** Jobs per minute, which is the unit an operator can compare against their patience. */
export function formatRate(snapshot: ProgressSnapshot): string {
  const perMinute = ratePerMs(snapshot) * 60_000;
  return perMinute === 0 ? 'warming up' : `${perMinute.toFixed(perMinute < 10 ? 1 : 0)} jobs/min`;
}

export function formatEta(snapshot: ProgressSnapshot): string {
  const remaining = snapshot.queue.pending + snapshot.queue.leased;
  if (remaining === 0) return 'done';
  const rate = ratePerMs(snapshot);
  // Under ten jobs there is no throughput to speak of, and dividing by it produces numbers that
  // are wrong by an order of magnitude — the kind an operator remembers and stops trusting.
  if (rate === 0 || snapshot.jobsRun < 10) return '—';
  return `~${formatDuration(remaining / rate)}`;
}

function ratePerMs(snapshot: ProgressSnapshot): number {
  return snapshot.elapsedMs <= 0 ? 0 : snapshot.jobsRun / snapshot.elapsedMs;
}

/** `1h 04m`, `4m 12s`, `9s` — never `0.15 hours`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) return `${String(hours)}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
  return `${String(seconds)}s`;
}

export interface SummaryInput extends ProgressSnapshot {
  runId: string;
  site: string;
  exitCode: number;
  finished: boolean;
  gaps: number;
  canary: { id: string; message: string } | null;
}

/**
 * The closing block.
 *
 * Written as aligned rows rather than a paragraph because the most common use of it is comparing
 * two runs, and a column of numbers compares in one glance.
 */
export function renderSummary(input: SummaryInput): string[] {
  const counted = countCases(input.cases);
  const storedDocs = input.blobs['STORED'] ?? 0;
  const knownDocs = storedDocs + (input.blobs['PENDING'] ?? 0);
  const byKind = Object.entries(input.queue.byKind)
    .map(([kind, k]) => `${kind} ${String(k.pending)} pending/${String(k.dead)} dead`)
    .join(' · ');

  const rows: [string, string][] = [
    ['run', `${input.runId} · ${input.site} · ${input.finished ? 'finished' : 'paused'}`],
    ['elapsed', formatDuration(input.elapsedMs)],
    [
      'jobs',
      `${String(input.jobsRun)} run by this process · ${String(input.queue.done)} done · ` +
        `${String(input.queue.pending)} pending · ${String(input.queue.dead)} dead`,
    ],
    ...(byKind === '' ? [] : ([['by kind', byKind]] as [string, string][])),
    [
      'cases',
      `${String(counted.total)} found · ${String(counted.detailed)} detailed` +
        (counted.failed === 0 ? '' : ` · ${String(counted.failed)} the site could not render`),
    ],
    ['documents', `${String(storedDocs)} stored of ${String(knownDocs)} known`],
    [
      'gaps',
      input.gaps === 0 ? 'none — every partition resolved below the cap' : String(input.gaps),
    ],
    ...(input.canary === null
      ? []
      : ([['canary', `${input.canary.id}: ${input.canary.message}`]] as [string, string][])),
    ['exit', `${String(input.exitCode)} — ${describeExit(input.exitCode)}`],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  return [
    '',
    '─'.repeat(64),
    ...rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`),
    '─'.repeat(64),
    ...nextStep(input),
  ];
}

/** Every code the process can return, in the words the README uses for it. */
export function describeExit(code: number): string {
  switch (code) {
    case 0:
      return 'the run completed and the queue is empty';
    case 1:
      return 'jobs remain in the dead letter queue';
    case 2:
      return 'the circuit breaker gave up on the site';
    case 3:
      return 'a canary tripped: the site changed';
    case 4:
      return 'a sanity check failed';
    case 130:
      return 'interrupted; the run is checkpointed';
    default:
      return 'unexpected failure';
  }
}

/** A run that ended badly should say what to type next, not only what went wrong. */
function nextStep(input: SummaryInput): string[] {
  switch (input.exitCode) {
    case 1:
      return ['', 'inspect them with `npm run dlq:list`, requeue with `npm run retry-dlq`.'];
    case 2:
      return [
        '',
        'the site refused for long enough that continuing would be rude. Resume later:',
        '',
        '  npm start',
      ];
    case 3:
      return [
        '',
        'the parser and the site disagree. Update the fixtures and the adapter before resuming;',
        'anything crawled from here would look fine and be wrong.',
      ];
    case 130:
      return [
        '',
        'resume with `npm start` — the partition tree and the queue are in the database.',
      ];
    default:
      return input.gaps > 0
        ? ['', 'see `npm run report` for the arithmetic behind each GAP.']
        : ['', 'next: `npm run verify`, then `npm run report`.'];
  }
}
