/**
 * The tiling invariant, tested the way a proof obligation deserves: on hand-built cases that
 * name each failure mode, and then on thousands of randomly generated trees — both valid ones,
 * which must pass, and deliberately mutated ones, which must not.
 *
 * A checker that only ever sees correct input is indistinguishable from `return true`.
 */
import { describe, expect, it } from 'vitest';
import {
  assertTiling,
  assertTransition,
  canTransition,
  isResolved,
  newPartitionNode,
  partitionId,
  splitByMidDay,
} from '../../src/core/engine/partitionTree.js';
import type { DateRange, PartitionNode, PartitionStatus } from '../../src/core/domain/types.js';
import { addDays, daysInRange } from '../../src/core/domain/dates.js';

const NOW = '2026-08-27T10:00:00-03:00';

function leaf(ini: string, fim: string, facets: Record<string, string> = {}): PartitionNode {
  return {
    ...newPartitionNode({ site: 's', runId: 'r', range: { ini, fim }, facets, now: NOW }),
    status: 'LEAF_DONE',
    observedRows: 1,
    truncated: false,
  };
}

describe('assertTiling on hand-built cases', () => {
  const root: DateRange = { ini: '2024-01-01', fim: '2024-01-31' };

  it('accepts a single leaf that is the whole root', () => {
    const result = assertTiling([leaf('2024-01-01', '2024-01-31')], root);
    expect(result.ok).toBe(true);
    expect(result.coveredDays).toBe(31);
    expect(result.rootDays).toBe(31);
  });

  it('accepts contiguous leaves in any input order', () => {
    const leaves = [
      leaf('2024-01-16', '2024-01-31'),
      leaf('2024-01-01', '2024-01-10'),
      leaf('2024-01-11', '2024-01-15'),
    ];
    expect(assertTiling(leaves, root).ok).toBe(true);
  });

  it('accepts one leaf per day', () => {
    const leaves = Array.from({ length: 31 }, (_, i) => {
      const day = addDays('2024-01-01', i);
      return leaf(day, day);
    });
    const result = assertTiling(leaves, root);
    expect(result.ok).toBe(true);
    expect(result.coveredDays).toBe(31);
  });

  it('reports a gap, and names the days nobody asked for', () => {
    const result = assertTiling(
      [leaf('2024-01-01', '2024-01-10'), leaf('2024-01-16', '2024-01-31')],
      root,
    );
    expect(result.ok).toBe(false);
    const gap = result.violations.find((v) => v.kind === 'gap');
    expect(gap?.range).toEqual({ ini: '2024-01-11', fim: '2024-01-15' });
    expect(gap?.detail).toContain('2024-01-11');
  });

  it('reports an overlap', () => {
    const result = assertTiling(
      [leaf('2024-01-01', '2024-01-20'), leaf('2024-01-15', '2024-01-31')],
      root,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.kind === 'overlap')).toBe(true);
  });

  it('reports a missing start', () => {
    const result = assertTiling([leaf('2024-01-05', '2024-01-31')], root);
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.kind === 'missing-start');
    expect(violation?.range).toEqual({ ini: '2024-01-01', fim: '2024-01-04' });
  });

  it('reports a missing end', () => {
    const result = assertTiling([leaf('2024-01-01', '2024-01-25')], root);
    expect(result.ok).toBe(false);
    const violation = result.violations.find((v) => v.kind === 'missing-end');
    expect(violation?.range).toEqual({ ini: '2024-01-26', fim: '2024-01-31' });
  });

  it('reports both ends when the middle is the only thing covered', () => {
    const result = assertTiling([leaf('2024-01-10', '2024-01-20')], root);
    expect(result.violations.map((v) => v.kind).sort()).toEqual(['missing-end', 'missing-start']);
  });

  it('refuses to call an empty set a tiling', () => {
    // The failure mode that matters most: a crawl that resolved nothing must not look complete.
    const result = assertTiling([], root);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.kind).toBe('empty');
  });

  it('ignores leaves filtered by class, which are already covered by their primary ancestor', () => {
    const leaves = [
      leaf('2024-01-01', '2024-01-31'),
      leaf('2024-01-15', '2024-01-15', { classe: 'APELAÇÃO CÍVEL' }),
      leaf('2024-01-15', '2024-01-15', { classe: 'AGRAVO DE INSTRUMENTO' }),
    ];
    // Counting the secondary leaves would report a false overlap on the 15th.
    expect(assertTiling(leaves, root).ok).toBe(true);
  });

  it('counts a GAP leaf as covered, because the range was asked for even if not exhausted', () => {
    const gap = { ...leaf('2024-01-15', '2024-01-15'), status: 'GAP' as const };
    const leaves = [leaf('2024-01-01', '2024-01-14'), gap, leaf('2024-01-16', '2024-01-31')];
    // The tiling is intact; the incompleteness is reported separately, as a GAP, with evidence.
    expect(assertTiling(leaves, root).ok).toBe(true);
  });
});

describe('assertTiling under randomised trees', () => {
  /** Deterministic PRNG, so a failure is reproducible rather than a story. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Builds a valid tiling by recursively splitting, exactly as the engine does. */
  function buildValidTiling(root: DateRange, next: () => number): PartitionNode[] {
    let frontier = [root];
    for (let depth = 0; depth < 8; depth++) {
      frontier = frontier.flatMap((range) =>
        next() < 0.55 ? (splitByMidDay(range) ?? [range]) : [range],
      );
    }
    return frontier.map((range) => leaf(range.ini, range.fim));
  }

  it('accepts 200 independently generated valid tilings', () => {
    const next = rng(20260827);
    for (let trial = 0; trial < 200; trial++) {
      const root: DateRange = {
        ini: '2020-01-01',
        fim: addDays('2020-01-01', Math.floor(next() * 500) + 1),
      };
      const result = assertTiling(buildValidTiling(root, next), root);
      expect(result.ok, `trial ${String(trial)}: ${JSON.stringify(result.violations)}`).toBe(true);
      expect(result.coveredDays).toBe(daysInRange(root));
    }
  });

  it('rejects every mutation of a valid tiling', () => {
    const next = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const root: DateRange = {
        ini: '2020-01-01',
        fim: addDays('2020-01-01', Math.floor(next() * 400) + 20),
      };
      const leaves = buildValidTiling(root, next);
      if (leaves.length < 3) continue;

      const victim = Math.floor(next() * leaves.length);
      const mutation = Math.floor(next() * 3);
      const mutated = [...leaves];

      if (mutation === 0) {
        // Drop a leaf: a gap, or a missing edge if it was first or last.
        mutated.splice(victim, 1);
      } else if (mutation === 1) {
        // Stretch a leaf forwards: an overlap with its neighbour.
        const target = mutated[victim];
        if (target === undefined) continue;
        mutated[victim] = {
          ...target,
          range: { ...target.range, fim: addDays(target.range.fim, 2) },
        };
      } else {
        // Shift a leaf's start later: a one-day hole.
        const target = mutated[victim];
        if (target === undefined || daysInRange(target.range) < 2) continue;
        mutated[victim] = {
          ...target,
          range: { ...target.range, ini: addDays(target.range.ini, 1) },
        };
      }

      const result = assertTiling(mutated, root);
      expect(result.ok, `trial ${String(trial)} mutation ${String(mutation)} slipped through`).toBe(
        false,
      );
    }
  });
});

describe('partition identity', () => {
  it('is stable and human-readable', () => {
    expect(partitionId({ ini: '2024-05-15', fim: '2024-05-15' })).toBe('2024-05-15..2024-05-15');
  });

  it('includes facets, sorted, so the same node always gets the same id', () => {
    const a = partitionId({ ini: '2024-05-15', fim: '2024-05-15' }, { classe: 'X', outro: 'Y' });
    const b = partitionId({ ini: '2024-05-15', fim: '2024-05-15' }, { outro: 'Y', classe: 'X' });
    expect(a).toBe(b);
    expect(a).toBe('2024-05-15..2024-05-15|classe=X,outro=Y');
  });

  it('distinguishes a primary node from its class-filtered children', () => {
    const range = { ini: '2024-05-15', fim: '2024-05-15' };
    expect(partitionId(range)).not.toBe(partitionId(range, { classe: 'X' }));
  });

  it('gives a new node the identity its range and facets imply', () => {
    const node = newPartitionNode({
      site: 's',
      runId: 'r',
      range: { ini: '2024-05-15', fim: '2024-05-15' },
      facets: { classe: 'X' },
      now: NOW,
    });
    expect(node.id).toBe('2024-05-15..2024-05-15|classe=X');
    expect(node.status).toBe('PENDING');
    expect(node.attempts).toBe(0);
  });
});

describe('state transitions', () => {
  it('allows the paths a crawl actually takes', () => {
    expect(canTransition('PENDING', 'LEAF_DONE')).toBe(true);
    expect(canTransition('PENDING', 'SPLIT')).toBe(true);
    expect(canTransition('PENDING', 'GAP')).toBe(true);
    expect(canTransition('FAILED', 'PENDING')).toBe(true);
    expect(canTransition('STALE', 'PENDING')).toBe(true);
    expect(canTransition('GAP', 'PENDING')).toBe(true);
  });

  it('refuses to un-resolve a finished leaf, which would re-count its rows', () => {
    expect(canTransition('LEAF_DONE', 'PENDING')).toBe(false);
    expect(canTransition('LEAF_DONE', 'SPLIT')).toBe(false);
  });

  it('refuses to declare a gap from a state that never hit the cap', () => {
    expect(canTransition('LEAF_DONE', 'GAP')).toBe(false);
  });

  it('throws with the node id, so a bad transition is diagnosable', () => {
    const node = { ...leaf('2024-01-01', '2024-01-01'), status: 'LEAF_DONE' as PartitionStatus };
    expect(() => {
      assertTransition(node, 'PENDING');
    }).toThrow(/2024-01-01..2024-01-01 cannot go from LEAF_DONE to PENDING/);
  });

  it('knows which statuses mean the node is finished', () => {
    expect(isResolved({ ...leaf('2024-01-01', '2024-01-01'), status: 'LEAF_DONE' })).toBe(true);
    expect(isResolved({ ...leaf('2024-01-01', '2024-01-01'), status: 'GAP' })).toBe(true);
    expect(isResolved({ ...leaf('2024-01-01', '2024-01-01'), status: 'PENDING' })).toBe(false);
    expect(isResolved({ ...leaf('2024-01-01', '2024-01-01'), status: 'SPLIT' })).toBe(false);
  });
});
