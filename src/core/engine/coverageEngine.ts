/**
 * The coverage engine: how a site with no pagination is nevertheless read completely.
 *
 * The problem, restated precisely. A query answers with at most `cap` rows and says whether it
 * truncated. There is no way to ask for "the next thirty". So completeness cannot be *observed*;
 * it has to be *constructed* — find a set of queries none of which truncates, whose ranges
 * exactly tile the space being claimed.
 *
 * The algorithm is therefore short, and everything interesting is in what it does when it cannot
 * proceed:
 *
 * ```
 * resolve(node):
 *   page = search(node)
 *   if not page.truncated:            node is a leaf. Its rows are all of its rows.
 *   else for each axis in order:      ask who can cut this node smaller
 *          if axis.canSplit:          replace the node with its children
 *   if no axis could:                 node is a GAP — declared, with arithmetic
 * ```
 *
 * Three properties this is built to have, in descending order of importance:
 *
 * **It never silently loses data.** A node that cannot be divided becomes a `GAP` carrying the
 * numbers that prove it: how many rows were visible, how many the known facet values accounted
 * for, and what the shortfall was. The rows it *could* see are still stored. A crawler that
 * quietly rounded that off would be worse than one that failed loudly.
 *
 * **It knows nothing about courts.** No dates, no classes, no thirty. It asks the adapter's axes
 * whether they can split, in the order the adapter listed them. A site that paginates normally
 * would supply a page axis and this file would not change.
 *
 * **It is resumable.** Every decision is a persisted node state, so a crawl that dies mid-tree
 * restarts from the frontier rather than from the root.
 */
import type { DateRange, ListedCase, PartitionNode } from '../domain/types.js';
import type { Axis, AxisContext, SearchPage } from '../ports/siteAdapter.js';
import { foldForComparison } from '../domain/text.js';
import { assertTransition, partitionId } from './partitionTree.js';

/** Why a node could not be divided further. Recorded on the node and surfaced in the report. */
export interface GapEvidence {
  reason: 'no-axis-can-split' | 'facet-arithmetic-short' | 'axis-produced-nothing';
  /** Rows the site showed for the node itself. */
  visibleRows: number;
  /** The cap that cut them off, as the site reported it. */
  capSeen: number | null;
  /** Sum of rows attributed to known facet values, when a secondary split was attempted. */
  attributedRows?: number;
  /** `visibleRows - attributedRows`: the rows nothing accounts for. */
  unexplainedRows?: number;
  /** Facet values that are prefixes of others, which make the arithmetic over-count. */
  prefixCollisions?: { shorter: string; longer: string }[];
  axesTried: string[];
}

export type CoverageOutcome =
  | { kind: 'leaf'; node: PartitionNode; rows: ListedCase[] }
  | { kind: 'split'; node: PartitionNode; children: PartitionNode[] }
  | { kind: 'gap'; node: PartitionNode; rows: ListedCase[]; evidence: GapEvidence };

export interface ResolveInput {
  node: PartitionNode;
  page: SearchPage;
  axes: readonly Axis[];
  /** Values already seen for a facet, which the secondary axis splits by. */
  vocabulary: (facet: string) => readonly string[];
  now: string;
}

/**
 * Decides what happens to one node, given the answer the site gave for it.
 *
 * Pure. It touches no network and no database, which is what makes the algorithm testable
 * against a table of scenarios rather than against a live crawl.
 */
export function resolvePartition(input: ResolveInput): CoverageOutcome {
  const { node, page, axes, vocabulary, now } = input;

  if (!page.truncated) {
    const status = Object.keys(node.facets).length === 0 ? 'LEAF_DONE' : 'LEAF_DONE_SECONDARY';
    assertTransition(node, status);
    return {
      kind: 'leaf',
      node: {
        ...node,
        status,
        observedRows: page.rows.length,
        truncated: false,
        capSeen: page.capSeen,
        updatedAt: now,
      },
      rows: page.rows,
    };
  }

  const ctx: AxisContext = {
    vocabulary,
    childId: (range: DateRange, facets: Record<string, string>) => partitionId(range, facets),
  };

  const axesTried: string[] = [];
  for (const axis of axes) {
    axesTried.push(axis.name);
    if (!axis.canSplit(node, page, ctx)) continue;

    const children = axis.split(node, page, ctx);
    if (children.length === 0) {
      // An axis that says it can split and then produces nothing is a bug in that axis, not a
      // property of the data. Declaring a GAP is the honest response; pretending it split is not.
      return gap(node, page, now, {
        reason: 'axis-produced-nothing',
        visibleRows: page.rows.length,
        capSeen: page.capSeen,
        axesTried,
      });
    }

    const status =
      Object.keys(children[0]?.facets ?? {}).length > Object.keys(node.facets).length
        ? 'SPLIT_SECONDARY'
        : 'SPLIT';
    assertTransition(node, status);
    return {
      kind: 'split',
      node: {
        ...node,
        status,
        observedRows: page.rows.length,
        truncated: true,
        capSeen: page.capSeen,
        updatedAt: now,
      },
      children: children.map((child) => ({ ...child, parentId: node.id, updatedAt: now })),
    };
  }

  // Every axis declined. This is the honest end of the line: the rows we can see are kept, and
  // the shortfall is stated in numbers rather than glossed over.
  return gap(node, page, now, {
    reason: 'no-axis-can-split',
    visibleRows: page.rows.length,
    capSeen: page.capSeen,
    axesTried,
  });
}

function gap(
  node: PartitionNode,
  page: SearchPage,
  now: string,
  evidence: GapEvidence,
): CoverageOutcome {
  assertTransition(node, 'GAP');
  return {
    kind: 'gap',
    node: {
      ...node,
      status: 'GAP',
      observedRows: page.rows.length,
      truncated: true,
      capSeen: page.capSeen,
      lastError: `${evidence.reason}: ${String(evidence.visibleRows)} rows visible, none of [${evidence.axesTried.join(', ')}] could divide it`,
      updatedAt: now,
    },
    rows: page.rows,
    evidence,
  };
}

// ─────────────────────── the closing arithmetic ───────────────────────

export interface FacetClosureInput {
  /** The parent node's own visible row count — what the cap showed before splitting. */
  visibleRows: number;
  /** Rows each facet-filtered child resolved, keyed by facet value. */
  byFacetValue: Map<string, number>;
  /** The residual child's count: the same range re-queried with no facet filter. */
  residualRows: number | null;
  /** All facet values in play, used to detect prefix over-matching. */
  facetValues: readonly string[];
}

export interface FacetClosure {
  ok: boolean;
  attributedRows: number;
  unexplainedRows: number;
  prefixCollisions: { shorter: string; longer: string }[];
  detail: string;
}

/**
 * Does the sum of the per-facet counts explain what the parent showed?
 *
 * This is the arithmetic that turns "we split by class and each part fit" into evidence. If the
 * known classes account for fewer rows than the parent displayed, there are classes nobody has
 * seen yet, and the day is **not** complete — no matter how neatly its children resolved.
 *
 * The complication is measured, not theoretical: this site's facet filter matches by **prefix**,
 * so if one known value is a prefix of another, filtering by the shorter one also returns the
 * longer one's rows and the sum over-counts. Detecting that is the difference between reporting
 * "complete" and reporting "complete, and here is why the numbers look odd".
 */
export function closeFacetSplit(input: FacetClosureInput): FacetClosure {
  const attributedRows = [...input.byFacetValue.values()].reduce((sum, n) => sum + n, 0);
  const prefixCollisions = findPrefixCollisions(input.facetValues);
  const unexplainedRows = Math.max(0, input.visibleRows - attributedRows);

  // The residual child asked the same range with no filter. If it came back under the cap, the
  // range is small enough to be read whole and the facet split was belt and braces.
  if (input.residualRows !== null && input.residualRows < input.visibleRows) {
    return {
      ok: true,
      attributedRows,
      unexplainedRows: 0,
      prefixCollisions,
      detail: `the residual query returned ${String(input.residualRows)} rows, below the ${String(input.visibleRows)} the parent showed`,
    };
  }

  if (attributedRows >= input.visibleRows) {
    return {
      ok: true,
      attributedRows,
      unexplainedRows: 0,
      prefixCollisions,
      detail:
        prefixCollisions.length === 0
          ? `${String(attributedRows)} rows attributed against ${String(input.visibleRows)} visible`
          : `${String(attributedRows)} rows attributed against ${String(input.visibleRows)} visible, ` +
            `inflated by ${String(prefixCollisions.length)} prefix collision(s) in the vocabulary`,
    };
  }

  return {
    ok: false,
    attributedRows,
    unexplainedRows,
    prefixCollisions,
    detail:
      `only ${String(attributedRows)} of ${String(input.visibleRows)} visible rows are accounted ` +
      `for by the ${String(input.facetValues.length)} known values; ${String(unexplainedRows)} ` +
      `row(s) belong to values never observed`,
  };
}

/** Values where one is a prefix of another, compared the way the site's filter compares. */
export function findPrefixCollisions(
  values: readonly string[],
): { shorter: string; longer: string }[] {
  const folded = values.map((value) => ({ value, key: foldForComparison(value) }));
  const collisions: { shorter: string; longer: string }[] = [];
  for (const a of folded) {
    for (const b of folded) {
      if (a.key !== b.key && b.key.startsWith(a.key)) {
        collisions.push({ shorter: a.value, longer: b.value });
      }
    }
  }
  return collisions;
}

// ─────────────────────────── root probing ───────────────────────────

export interface EdgeProbe {
  range: DateRange;
  label: 'before-root' | 'after-root';
}

/**
 * Two queries outside the configured root.
 *
 * Choosing the root badly is the one way to be *completely* wrong while every internal invariant
 * holds: a perfect tiling of the wrong window. These probes cost two requests and turn that from
 * a silent assumption into a warning with a number attached.
 */
export function edgeProbes(root: DateRange, span = 3650): EdgeProbe[] {
  return [
    {
      label: 'before-root',
      range: { ini: shift(root.ini, -span), fim: shift(root.ini, -1) },
    },
    { label: 'after-root', range: { ini: shift(root.fim, 1), fim: shift(root.fim, span) } },
  ];
}

function shift(iso: string, days: number): string {
  const [y = '2000', m = '01', d = '01'] = iso.split('-');
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d)) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
