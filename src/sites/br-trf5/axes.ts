/**
 * How a truncated partition gets cut into smaller ones.
 *
 * The engine asks each axis in order and takes the first that can split, so this array *is* the
 * partitioning strategy: `[DateAxis, ClasseAxis]`.
 *
 * **DateAxis** halves the range. It works until the range is a single day.
 *
 * **ClasseAxis** takes over there, re-querying the day once per known judicial class. The
 * phase-0 spike changed how important this is: 9 of 18 sampled days came back truncated, so a
 * day overflowing is the common case, not the exception. It also found the two properties that
 * shape the implementation:
 *
 *   · the filter is **accent-insensitive**, so the vocabulary compares folded;
 *   · the filter matches by **prefix**, so a class that is a prefix of another over-matches.
 *     That loses no data (deduplication is by `idProcessoTrf`) but it does break the arithmetic
 *     that proves a day is complete, so prefix collisions are detected and recorded rather than
 *     assumed away.
 *
 * There is no third axis. The spike measured that a partial case number does **not** filter, so
 * a day where one single class exceeds the cap is declared a `GAP` with its arithmetic, not
 * quietly rounded off.
 */
import type { PartitionNode } from '../../core/domain/types.js';
import type { Axis, AxisContext, SearchPage } from '../../core/ports/siteAdapter.js';
import { daysInRange, splitByMidDay } from '../../core/domain/dates.js';
import { foldForComparison } from '../../core/domain/text.js';

export const CLASSE_FACET = 'classe';

/**
 * The node that catches whatever the known classes did not explain. It is queried with no class
 * filter and exists so the report can say "these rows were visible but unattributed" instead of
 * pretending the day was covered.
 */
export const RESIDUAL_VALUE = '__RESIDUAL__';

export const dateAxis: Axis = {
  name: 'date',

  canSplit(node) {
    return daysInRange(node.range) > 1;
  },

  split(node, _page, ctx) {
    const halves = splitByMidDay(node.range);
    if (halves === null) return [];
    return halves.map((range) => childNode(node, range, node.facets, ctx));
  },
};

export const classeAxis: Axis = {
  name: CLASSE_FACET,

  canSplit(node, page, ctx) {
    // Only meaningful once the date axis has run out, and only if there is a vocabulary to
    // split by. A day with an empty vocabulary cannot be divided, and saying so is what turns
    // it into a declared GAP instead of a silent loss.
    if (daysInRange(node.range) > 1) return false;
    if (node.facets[CLASSE_FACET] !== undefined) return false;
    return classesFor(page, ctx).length > 0;
  },

  split(node, page, ctx) {
    const classes = classesFor(page, ctx);
    const children = classes.map((value) =>
      childNode(node, node.range, { ...node.facets, [CLASSE_FACET]: value }, ctx),
    );
    // The residual node re-asks the same day with no filter. Its row count is what the
    // arithmetic compares against the sum of the per-class counts.
    children.push(
      childNode(node, node.range, { ...node.facets, [CLASSE_FACET]: RESIDUAL_VALUE }, ctx),
    );
    return children;
  },
};

/** The vocabulary, plus anything this page just revealed, folded so accents do not duplicate. */
function classesFor(page: SearchPage, ctx: AxisContext): string[] {
  const seen = new Map<string, string>();
  for (const value of [...ctx.vocabulary(CLASSE_FACET), ...page.rows.map((r) => r.classe)]) {
    const key = foldForComparison(value);
    if (key !== '' && !seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Class values where one is a prefix of another.
 *
 * Filtering by the shorter one also returns the longer one's rows, which is harmless for the
 * data and fatal for the closing arithmetic. The engine records these on the node so the report
 * can explain a count that does not add up, instead of the run failing a sanity check with no
 * explanation.
 */
export function prefixCollisions(values: readonly string[]): { shorter: string; longer: string }[] {
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

function childNode(
  parent: PartitionNode,
  range: { ini: string; fim: string },
  facets: Record<string, string>,
  ctx: AxisContext,
): PartitionNode {
  return {
    site: parent.site,
    id: ctx.childId(range, facets),
    runId: parent.runId,
    parentId: parent.id,
    range,
    facets,
    status: 'PENDING',
    observedRows: null,
    truncated: null,
    capSeen: null,
    attempts: 0,
    lastError: null,
    updatedAt: parent.updatedAt,
  };
}

export const TRF5_AXES: readonly Axis[] = [dateAxis, classeAxis];
