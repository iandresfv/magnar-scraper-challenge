/**
 * The coverage algorithm, driven by an in-memory site.
 *
 * The fake site here is not a mock of the adapter — it is a small model of *a site with a cap*:
 * give it a set of cases and it answers queries by filtering and truncating, exactly as a real
 * one does. That makes the interesting test possible: crawl a synthetic corpus to completion and
 * assert that the number of distinct cases found equals the number that exist. Not "roughly",
 * not "the code path ran" — equal.
 */
import { describe, expect, it } from 'vitest';
import {
  closeFacetSplit,
  edgeProbes,
  findPrefixCollisions,
  resolvePartition,
} from '../../src/core/engine/coverageEngine.js';
import { assertTiling, newPartitionNode } from '../../src/core/engine/partitionTree.js';
import { classeAxis, dateAxis, RESIDUAL_VALUE } from '../../src/sites/br-trf5/axes.js';
import type { DateRange, ListedCase, PartitionNode } from '../../src/core/domain/types.js';
import type { SearchPage } from '../../src/core/ports/siteAdapter.js';
import { compareIsoDate, daysInRange } from '../../src/core/domain/dates.js';

const NOW = '2026-08-27T10:00:00-03:00';
const AXES = [dateAxis, classeAxis];

// ───────────────────────── an in-memory site with a cap ─────────────────────────

interface FakeCase {
  id: string;
  day: string;
  classe: string;
}

class CappedSite {
  queries = 0;
  constructor(
    readonly cases: FakeCase[],
    readonly cap = 30,
  ) {}

  search(range: DateRange, facets: Record<string, string>): SearchPage {
    this.queries++;
    let matches = this.cases.filter(
      (c) => compareIsoDate(c.day, range.ini) >= 0 && compareIsoDate(c.day, range.fim) <= 0,
    );
    const classe = facets['classe'];
    if (classe !== undefined && classe !== RESIDUAL_VALUE) {
      // Prefix matching, as measured on the real site.
      matches = matches.filter((c) => c.classe.startsWith(classe));
    }
    matches.sort((a, b) => a.id.localeCompare(b.id));

    const truncated = matches.length > this.cap;
    const shown = matches.slice(0, this.cap);
    return {
      rows: shown.map((c) => listed(c, range)),
      truncated,
      capSeen: truncated ? this.cap : null,
      emptyMarker: shown.length === 0,
    };
  }
}

function listed(c: FakeCase, range: DateRange): ListedCase {
  return {
    site: 's',
    idOrigem: c.id,
    ca: '',
    numero: `0000001-07.1985.8.20.0124`,
    classe: c.classe,
    sigla: null,
    assuntoResumo: '',
    partesResumo: '',
    ultimaMovimentacao: null,
    partitionId: `${range.ini}..${range.fim}`,
    partitionRange: range,
    contentHash: 'h',
    listedAt: NOW,
  };
}

/** Runs the algorithm to a fixed point, as the real planner does. */
function crawl(
  site: CappedSite,
  root: DateRange,
): { leaves: PartitionNode[]; gaps: PartitionNode[]; found: Set<string>; queries: number } {
  const vocabulary = new Set<string>();
  const frontier: PartitionNode[] = [
    newPartitionNode({ site: 's', runId: 'r', range: root, now: NOW }),
  ];
  const leaves: PartitionNode[] = [];
  const gaps: PartitionNode[] = [];
  const found = new Set<string>();

  let guard = 0;
  while (frontier.length > 0) {
    if (++guard > 20_000) throw new Error('the crawl did not converge');
    const node = frontier.pop();
    if (node === undefined) break;

    const page = site.search(node.range, node.facets);
    for (const row of page.rows) {
      found.add(row.idOrigem);
      vocabulary.add(row.classe);
    }

    const outcome = resolvePartition({
      node,
      page,
      axes: AXES,
      vocabulary: () => [...vocabulary],
      now: NOW,
    });

    if (outcome.kind === 'leaf') leaves.push(outcome.node);
    else if (outcome.kind === 'gap') gaps.push(outcome.node);
    else {
      // A day subdivided by class still covers its own range; the tiling check needs it.
      if (outcome.node.status === 'SPLIT_SECONDARY') leaves.push(outcome.node);
      frontier.push(...outcome.children);
    }
  }

  return { leaves, gaps, found, queries: site.queries };
}

function buildCorpus(spec: { day: string; count: number; classes?: string[] }[]): FakeCase[] {
  const classes = ['APELAÇÃO CÍVEL', 'AGRAVO DE INSTRUMENTO', 'MANDADO DE SEGURANÇA'];
  let id = 1000;
  return spec.flatMap(({ day, count, classes: only }) =>
    Array.from({ length: count }, (_, i) => ({
      id: String(id++),
      day,
      classe: (only ?? classes)[i % (only ?? classes).length] ?? 'X',
    })),
  );
}

// ───────────────────────────── the tests ─────────────────────────────

describe('resolvePartition', () => {
  const node = (over: Partial<PartitionNode> = {}): PartitionNode => ({
    ...newPartitionNode({
      site: 's',
      runId: 'r',
      range: { ini: '2024-01-01', fim: '2024-12-31' },
      now: NOW,
    }),
    ...over,
  });

  const page = (rows: number, truncated: boolean): SearchPage => ({
    rows: Array.from({ length: rows }, (_, i) =>
      listed(
        { id: String(i), day: '2024-01-01', classe: 'A' },
        { ini: '2024-01-01', fim: '2024-01-01' },
      ),
    ),
    truncated,
    capSeen: truncated ? 30 : null,
    emptyMarker: rows === 0,
  });

  it('calls an untruncated node a leaf and keeps its rows', () => {
    const outcome = resolvePartition({
      node: node(),
      page: page(12, false),
      axes: AXES,
      vocabulary: () => [],
      now: NOW,
    });
    expect(outcome.kind).toBe('leaf');
    if (outcome.kind === 'leaf') {
      expect(outcome.node.status).toBe('LEAF_DONE');
      expect(outcome.node.observedRows).toBe(12);
      expect(outcome.rows).toHaveLength(12);
    }
  });

  it('calls an empty node a leaf, so a wide root is cheap to prune', () => {
    const outcome = resolvePartition({
      node: node(),
      page: page(0, false),
      axes: AXES,
      vocabulary: () => [],
      now: NOW,
    });
    expect(outcome.kind).toBe('leaf');
  });

  it('splits a truncated multi-day node by date', () => {
    const outcome = resolvePartition({
      node: node(),
      page: page(30, true),
      axes: AXES,
      vocabulary: () => [],
      now: NOW,
    });
    expect(outcome.kind).toBe('split');
    if (outcome.kind === 'split') {
      expect(outcome.node.status).toBe('SPLIT');
      expect(outcome.children).toHaveLength(2);
      expect(outcome.children.every((c) => c.parentId === outcome.node.id)).toBe(true);
    }
  });

  it('falls through to the class axis once the range is a single day', () => {
    const day = node({ range: { ini: '2024-05-15', fim: '2024-05-15' } });
    const outcome = resolvePartition({
      node: day,
      page: page(30, true),
      axes: AXES,
      vocabulary: () => ['APELAÇÃO CÍVEL', 'AGRAVO DE INSTRUMENTO'],
      now: NOW,
    });
    expect(outcome.kind).toBe('split');
    if (outcome.kind === 'split') {
      expect(outcome.node.status).toBe('SPLIT_SECONDARY');
      // One child per class the vocabulary knows, plus any the page itself revealed. There is
      // no extra "residual" child: re-asking the same day unfiltered returns the same truncated
      // answer the parent already had. See the note in sites/br-trf5/axes.ts.
      expect(outcome.children.map((c) => c.facets['classe']).sort()).toEqual([
        'A',
        'AGRAVO DE INSTRUMENTO',
        'APELAÇÃO CÍVEL',
      ]);
      expect(outcome.children.map((c) => c.facets['classe'])).not.toContain(RESIDUAL_VALUE);
    }
  });

  it('declares a GAP when no axis can divide the node, and keeps what it saw', () => {
    // A single day, already filtered by class, still over the cap: the end of the line, and the
    // situation the phase-0 spike proved has no third axis to fall back on.
    const stuck = node({
      range: { ini: '2024-05-15', fim: '2024-05-15' },
      facets: { classe: 'APELAÇÃO CÍVEL' },
    });
    const outcome = resolvePartition({
      node: stuck,
      page: page(30, true),
      axes: AXES,
      vocabulary: () => ['APELAÇÃO CÍVEL'],
      now: NOW,
    });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') {
      expect(outcome.node.status).toBe('GAP');
      expect(outcome.rows).toHaveLength(30);
      expect(outcome.evidence.reason).toBe('no-axis-can-split');
      expect(outcome.evidence.visibleRows).toBe(30);
      expect(outcome.evidence.capSeen).toBe(30);
      expect(outcome.evidence.axesTried).toEqual(['date', 'classe']);
      expect(outcome.node.lastError).toContain('date, classe');
    }
  });

  it('declares a GAP rather than trusting an axis that promised a split and produced none', () => {
    const brokenAxis = {
      name: 'broken',
      canSplit: () => true,
      split: () => [],
    };
    const outcome = resolvePartition({
      node: node(),
      page: page(30, true),
      axes: [brokenAxis],
      vocabulary: () => [],
      now: NOW,
    });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind === 'gap') expect(outcome.evidence.reason).toBe('axis-produced-nothing');
  });

  it('knows nothing about courts: it uses whatever axes it was handed', () => {
    // A site that paginates would supply an axis like this one, and the engine would not change.
    const pageAxis = {
      name: 'page',
      canSplit: () => true,
      split: (n: PartitionNode) => [
        { ...n, id: `${n.id}#1`, facets: { page: '1' }, status: 'PENDING' as const },
        { ...n, id: `${n.id}#2`, facets: { page: '2' }, status: 'PENDING' as const },
      ],
    };
    const outcome = resolvePartition({
      node: node(),
      page: page(30, true),
      axes: [pageAxis],
      vocabulary: () => [],
      now: NOW,
    });
    expect(outcome.kind).toBe('split');
    if (outcome.kind === 'split') expect(outcome.children).toHaveLength(2);
  });
});

describe('completeness against a synthetic corpus', () => {
  it('finds every case spread over a year, and tiles the root exactly', () => {
    const root = { ini: '2024-01-01', fim: '2024-12-31' };
    const days = Array.from({ length: 366 }, (_, i) => {
      const day = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
      // A deliberately lumpy distribution: most days empty, a few crowded.
      const count = i % 73 === 0 ? 40 : i % 7 === 0 ? 5 : i % 3 === 0 ? 1 : 0;
      return { day, count };
    });
    const corpus = buildCorpus(days);
    expect(corpus.length).toBeGreaterThan(400);

    const site = new CappedSite(corpus);
    const result = crawl(site, root);

    expect(result.found.size).toBe(corpus.length);
    expect(result.gaps).toHaveLength(0);
    expect(assertTiling(result.leaves, root).ok).toBe(true);
  });

  it('costs a number of queries proportional to the days with data, not to the calendar', () => {
    const root = { ini: '2020-01-01', fim: '2024-12-31' };
    // Five years of root, data in three days. Empty halves must be pruned with one query each.
    const corpus = buildCorpus([
      { day: '2022-06-01', count: 5 },
      { day: '2022-06-02', count: 5 },
      { day: '2023-01-01', count: 5 },
    ]);
    const site = new CappedSite(corpus);
    const result = crawl(site, root);

    expect(result.found.size).toBe(15);
    expect(assertTiling(result.leaves, root).ok).toBe(true);
    // 1827 days in the root; a linear scan would be that many queries.
    expect(daysInRange(root)).toBe(1827);
    expect(result.queries).toBeLessThan(30);
  });

  it('uses the class axis when a single day overflows, and still finds everything', () => {
    const root = { ini: '2024-05-01', fim: '2024-05-31' };
    // 45 cases on one day, spread across three classes: no single class exceeds the cap.
    const corpus = buildCorpus([
      { day: '2024-05-15', count: 45 },
      { day: '2024-05-20', count: 3 },
    ]);
    const site = new CappedSite(corpus);
    const result = crawl(site, root);

    expect(result.found.size).toBe(48);
    expect(result.gaps).toHaveLength(0);
    expect(result.leaves.some((l) => Object.keys(l.facets).length > 0)).toBe(true);
    expect(assertTiling(result.leaves, root).ok).toBe(true);
  });

  it('declares a GAP — and only there — when one class alone exceeds the cap', () => {
    const root = { ini: '2024-05-01', fim: '2024-05-31' };
    const corpus = buildCorpus([
      { day: '2024-05-15', count: 45, classes: ['APELAÇÃO CÍVEL'] },
      { day: '2024-05-20', count: 3 },
    ]);
    const site = new CappedSite(corpus);
    const result = crawl(site, root);

    // The tiling still holds: the day was asked for, it just could not be exhausted.
    const tiling = assertTiling(result.leaves.concat(result.gaps), root);
    expect(tiling.violations, JSON.stringify(tiling.violations)).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.range).toEqual({ ini: '2024-05-15', fim: '2024-05-15' });
    // What was visible is still kept: 30 of the 45, plus the other day's 3.
    expect(result.found.size).toBe(33);
    // And the rest of the month resolved normally rather than being tainted by its neighbour.
    // Note the leaf covering the 20th is the whole range 05-16..05-31: it held only three cases,
    // so it never needed dividing. Completeness is about cover, not about granularity.
    const covering20 = result.leaves.find(
      (l) => l.range.ini <= '2024-05-20' && l.range.fim >= '2024-05-20',
    );
    expect(covering20?.status).toBe('LEAF_DONE');
    expect(covering20?.observedRows).toBe(3);
  });

  it('terminates on a corpus that is entirely one overflowing day', () => {
    const site = new CappedSite(buildCorpus([{ day: '2024-05-15', count: 200, classes: ['ONE'] }]));
    const result = crawl(site, { ini: '2024-05-15', fim: '2024-05-15' });
    expect(result.gaps).toHaveLength(1);
    expect(result.found.size).toBe(30);
  });

  it('handles an entirely empty corpus without claiming anything', () => {
    const site = new CappedSite([]);
    const root = { ini: '2024-01-01', fim: '2024-12-31' };
    const result = crawl(site, root);
    expect(result.found.size).toBe(0);
    expect(result.queries).toBe(1);
    expect(assertTiling(result.leaves, root).ok).toBe(true);
  });
});

describe('the closing arithmetic', () => {
  it('accepts a split whose parts account for everything the parent showed', () => {
    const closure = closeFacetSplit({
      visibleRows: 30,
      byFacetValue: new Map([
        ['A', 20],
        ['B', 15],
      ]),
      residualRows: null,
      facetValues: ['A', 'B'],
    });
    expect(closure.ok).toBe(true);
    expect(closure.attributedRows).toBe(35);
  });

  it('refuses a split whose parts do not add up, and says by how much', () => {
    // The situation that means "there are classes nobody has seen yet".
    const closure = closeFacetSplit({
      visibleRows: 30,
      byFacetValue: new Map([
        ['A', 10],
        ['B', 8],
      ]),
      residualRows: null,
      facetValues: ['A', 'B'],
    });
    expect(closure.ok).toBe(false);
    expect(closure.unexplainedRows).toBe(12);
    expect(closure.detail).toContain('12');
    expect(closure.detail).toContain('never observed');
  });

  it('accepts when the residual query itself came back under the cap', () => {
    const closure = closeFacetSplit({
      visibleRows: 30,
      byFacetValue: new Map([['A', 5]]),
      residualRows: 24,
      facetValues: ['A'],
    });
    expect(closure.ok).toBe(true);
    expect(closure.detail).toContain('residual');
  });

  it('reports prefix collisions, which inflate the sum', () => {
    // Measured: the filter matches by prefix, so `APELAÇÃO` also returns `APELAÇÃO CÍVEL`.
    const closure = closeFacetSplit({
      visibleRows: 30,
      byFacetValue: new Map([
        ['APELAÇÃO', 30],
        ['APELAÇÃO CÍVEL', 12],
      ]),
      residualRows: null,
      facetValues: ['APELAÇÃO', 'APELAÇÃO CÍVEL'],
    });
    expect(closure.ok).toBe(true);
    expect(closure.prefixCollisions).toHaveLength(1);
    expect(closure.detail).toContain('prefix collision');
  });

  it('finds prefix collisions insensitively to accents, as the site compares them', () => {
    expect(findPrefixCollisions(['APELACAO', 'APELAÇÃO CÍVEL'])).toEqual([
      { shorter: 'APELACAO', longer: 'APELAÇÃO CÍVEL' },
    ]);
    expect(findPrefixCollisions(['AGRAVO', 'APELAÇÃO'])).toEqual([]);
  });
});

describe('edge probes', () => {
  it('asks on both sides of the root, so a badly chosen window cannot pass silently', () => {
    const probes = edgeProbes({ ini: '2020-01-01', fim: '2024-12-31' }, 3650);
    expect(probes.map((p) => p.label)).toEqual(['before-root', 'after-root']);
    expect(probes[0]?.range.fim).toBe('2019-12-31');
    expect(probes[1]?.range.ini).toBe('2025-01-01');
  });

  it('does not overlap the root it is probing around', () => {
    const root = { ini: '2020-01-01', fim: '2024-12-31' };
    for (const probe of edgeProbes(root)) {
      const before = compareIsoDate(probe.range.fim, root.ini) < 0;
      const after = compareIsoDate(probe.range.ini, root.fim) > 0;
      expect(before || after).toBe(true);
    }
  });
});
