/**
 * The partition tree, and the invariant that makes completeness provable rather than hoped for.
 *
 * The site has no pagination and caps every answer at thirty rows, so "we saw everything" cannot
 * be established by walking pages. It has to be *constructed*: cut the search space into pieces
 * small enough that none is truncated, and then show that the pieces cover the whole space with
 * no gap and no overlap. That second half is what this file is about.
 *
 * `assertTiling` is the proof obligation. Given the resolved primary leaves it checks three
 * things, and each corresponds to a way the crawl could be silently wrong:
 *
 *   · the first leaf starts where the root starts   — otherwise the beginning was never asked for;
 *   · each leaf starts the day after the previous ends — otherwise a day fell between two queries;
 *   · the last leaf ends where the root ends        — otherwise the tail was never asked for.
 *
 * The database enforces non-overlap independently, with an `EXCLUDE USING gist` constraint, so
 * the two mechanisms check each other: code can be wrong, and a constraint can be dropped, but
 * both failing the same way is unlikely. What the constraint cannot see is a **gap**, because a
 * missing row violates nothing — which is precisely why this function exists.
 */
import type { DateRange, PartitionNode, PartitionStatus } from '../domain/types.js';
import {
  addDays,
  compareIsoDate,
  daysInRange,
  isContiguous,
  rangeId,
  rangesOverlap,
  splitByMidDay,
} from '../domain/dates.js';

export interface TilingViolation {
  kind: 'gap' | 'overlap' | 'missing-start' | 'missing-end' | 'empty';
  range: DateRange;
  detail: string;
}

export interface TilingResult {
  ok: boolean;
  violations: TilingViolation[];
  /** Days covered by the leaves. Equals the root's length when the tiling is complete. */
  coveredDays: number;
  rootDays: number;
}

/**
 * Statuses in which a node with no facet filter accounts for its whole date range.
 *
 * `SPLIT_SECONDARY` belongs here and it is easy to miss: a day that was subdivided by class is
 * still, in the date dimension, covered exactly once — by itself. Its class children carry a
 * facet and are deliberately excluded, so leaving the parent out too would leave that day
 * covered by nothing and report a phantom gap. `GAP` belongs here for a related reason: the
 * range *was* queried, it simply could not be exhausted, and that incompleteness is reported on
 * its own terms rather than as a hole in the calendar.
 */
export const COVERING_STATUSES: readonly PartitionStatus[] = [
  'LEAF_DONE',
  'GAP',
  'SPLIT_SECONDARY',
];

export function coversItsRange(node: PartitionNode): boolean {
  return Object.keys(node.facets).length === 0 && COVERING_STATUSES.includes(node.status);
}

/**
 * Checks that the covering nodes exactly tile `root`.
 *
 * Only nodes with **no facet filter** participate: a day split by class is covered once by
 * itself, and counting its children too would report a false overlap.
 */
export function assertTiling(leaves: readonly PartitionNode[], root: DateRange): TilingResult {
  const primary = leaves
    .filter(coversItsRange)
    .sort((a, b) => compareIsoDate(a.range.ini, b.range.ini));

  const rootDays = daysInRange(root);
  const violations: TilingViolation[] = [];

  if (primary.length === 0) {
    return {
      ok: false,
      violations: [{ kind: 'empty', range: root, detail: 'no resolved leaves at all' }],
      coveredDays: 0,
      rootDays,
    };
  }

  const first = primary[0];
  const last = primary[primary.length - 1];
  if (first === undefined || last === undefined) throw new Error('unreachable');

  if (compareIsoDate(first.range.ini, root.ini) !== 0) {
    violations.push({
      kind: 'missing-start',
      range: { ini: root.ini, fim: addDays(first.range.ini, -1) },
      detail: `the first leaf starts at ${first.range.ini}, but the root starts at ${root.ini}`,
    });
  }

  if (compareIsoDate(last.range.fim, root.fim) !== 0) {
    violations.push({
      kind: 'missing-end',
      range: { ini: addDays(last.range.fim, 1), fim: root.fim },
      detail: `the last leaf ends at ${last.range.fim}, but the root ends at ${root.fim}`,
    });
  }

  let coveredDays = daysInRange(first.range);
  for (let i = 1; i < primary.length; i++) {
    const previous = primary[i - 1];
    const current = primary[i];
    if (previous === undefined || current === undefined) throw new Error('unreachable');
    coveredDays += daysInRange(current.range);

    if (rangesOverlap(previous.range, current.range)) {
      violations.push({
        kind: 'overlap',
        range: {
          ini: current.range.ini,
          fim:
            compareIsoDate(previous.range.fim, current.range.fim) < 0
              ? previous.range.fim
              : current.range.fim,
        },
        detail: `${previous.id} and ${current.id} both cover ${current.range.ini}`,
      });
      continue;
    }

    if (!isContiguous(previous.range, current.range)) {
      violations.push({
        kind: 'gap',
        range: { ini: addDays(previous.range.fim, 1), fim: addDays(current.range.ini, -1) },
        detail: `nothing covers ${addDays(previous.range.fim, 1)}..${addDays(current.range.ini, -1)}`,
      });
    }
  }

  return { ok: violations.length === 0, violations, coveredDays, rootDays };
}

/** The identity of a node. Deterministic, so a resumed run reuses rows instead of duplicating. */
export function partitionId(range: DateRange, facets: Record<string, string> = {}): string {
  const base = rangeId(range);
  const encoded = Object.entries(facets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return encoded === '' ? base : `${base}|${encoded}`;
}

export function newPartitionNode(input: {
  site: string;
  runId: string;
  range: DateRange;
  facets?: Record<string, string>;
  parentId?: string | null;
  now: string;
}): PartitionNode {
  const facets = input.facets ?? {};
  return {
    site: input.site,
    id: partitionId(input.range, facets),
    runId: input.runId,
    parentId: input.parentId ?? null,
    range: input.range,
    facets,
    status: 'PENDING',
    observedRows: null,
    truncated: null,
    capSeen: null,
    attempts: 0,
    lastError: null,
    updatedAt: input.now,
  };
}

/**
 * The legal state transitions.
 *
 * Written out because the states are the crawl's memory: a node that goes from `LEAF_DONE` back
 * to `PENDING` would re-query work already counted, and a node that reaches `GAP` from anywhere
 * but a truncated state would be declaring a hole that was never actually hit.
 */
const TRANSITIONS: Record<PartitionStatus, readonly PartitionStatus[]> = {
  PENDING: [
    'SPLIT',
    'SPLIT_SECONDARY',
    'LEAF_DONE',
    'LEAF_DONE_SECONDARY',
    'GAP',
    'FAILED',
    'PENDING',
  ],
  SPLIT: ['SPLIT', 'STALE'],
  SPLIT_SECONDARY: ['SPLIT_SECONDARY', 'STALE', 'GAP'],
  LEAF_DONE: ['STALE', 'LEAF_DONE'],
  LEAF_DONE_SECONDARY: ['STALE', 'LEAF_DONE_SECONDARY'],
  GAP: ['PENDING', 'GAP'],
  STALE: ['PENDING', 'STALE'],
  FAILED: ['PENDING', 'FAILED', 'GAP'],
};

export function canTransition(from: PartitionStatus, to: PartitionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(node: PartitionNode, to: PartitionStatus): void {
  if (!canTransition(node.status, to)) {
    throw new Error(`partition ${node.id} cannot go from ${node.status} to ${to}`);
  }
}

/** Statuses that mean "this node is finished and its rows have been counted". */
export const RESOLVED_STATUSES: readonly PartitionStatus[] = [
  'LEAF_DONE',
  'LEAF_DONE_SECONDARY',
  'GAP',
];

export function isResolved(node: PartitionNode): boolean {
  return RESOLVED_STATUSES.includes(node.status);
}

/**
 * Splits a range in half.
 *
 * Re-exported from the date module so that engine code has one obvious place to reach for it,
 * and so the tiling tests and the axis implementation demonstrably use the same function.
 */
export { splitByMidDay };
