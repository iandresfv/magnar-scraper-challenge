/**
 * The hexagonal dependency rule, as a test over the real import graph.
 *
 * ESLint already carries an equivalent `no-restricted-imports` rule and gives faster feedback
 * while typing. This test exists anyway, for two reasons: it survives someone disabling a rule
 * inline, and it walks the graph transitively — a `core/` file that imports a `core/` file that
 * imports `infra/` still breaks the architecture, and a per-file lint rule would not notice.
 *
 * The rule itself:
 *   core/   imports only core/ and shared/    (it must not know that PJe, Postgres or S3 exist)
 *   sites/  imports core/ and shared/         (a court knows the domain, not the infrastructure)
 *   infra/  imports core/ and shared/         (an adapter implements a port, it does not use a site)
 *   app/    imports everything                (composition happens in exactly one layer)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

type Layer = 'core' | 'sites' | 'infra' | 'app' | 'shared';

/** Which layers each layer is allowed to reach, directly or transitively. */
const ALLOWED: Record<Layer, readonly Layer[]> = {
  core: ['core', 'shared'],
  sites: ['sites', 'core', 'shared'],
  infra: ['infra', 'core', 'shared'],
  app: ['app', 'sites', 'infra', 'core', 'shared'],
  shared: ['shared'],
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function layerOf(file: string): Layer | null {
  const rel = relative(SRC, file);
  const top = rel.split('/')[0];
  return top === 'core' || top === 'sites' || top === 'infra' || top === 'app' || top === 'shared'
    ? top
    : null;
}

/** Relative specifiers only; a bare specifier is a package, which no layer rule constrains. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const spec = match[1];
    if (spec !== undefined && spec.startsWith('.')) specifiers.push(spec);
  }
  return specifiers;
}

/** `./foo.js` on disk is `./foo.ts`; NodeNext requires the `.js` extension in the source. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  return base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : `${base}.ts`;
}

const files = walk(SRC);

/** file -> files it imports, restricted to files inside src/. */
const graph = new Map<string, string[]>(
  files.map((file) => [
    file,
    importsOf(file)
      .map((spec) => resolveSpecifier(file, spec))
      .filter((target) => files.includes(target)),
  ]),
);

/** Every file reachable from `start`, excluding `start` itself. */
function reachableFrom(start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(graph.get(start) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return seen;
}

describe('hexagonal import rule', () => {
  it('finds source files to check, so a broken walker cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => layerOf(f) === 'core')).toBe(true);
  });

  it('resolves every relative import to a real file', () => {
    // A typo in a specifier would otherwise make this whole suite silently weaker.
    const unresolved: string[] = [];
    for (const file of files) {
      for (const spec of importsOf(file)) {
        const target = resolveSpecifier(file, spec);
        if (!files.includes(target)) unresolved.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  for (const layer of ['core', 'sites', 'infra', 'shared'] as const) {
    it(`${layer}/ reaches only ${ALLOWED[layer].join(', ')} — transitively`, () => {
      const violations: string[] = [];
      for (const file of files.filter((f) => layerOf(f) === layer)) {
        for (const target of reachableFrom(file)) {
          const targetLayer = layerOf(target);
          if (targetLayer !== null && !ALLOWED[layer].includes(targetLayer)) {
            violations.push(`${relative(SRC, file)} -> ${relative(SRC, target)}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it('has no import cycles', () => {
    // Not part of the layering rule, but a cycle makes the transitive check above meaningless
    // and is a design smell in its own right.
    const state = new Map<string, 'visiting' | 'done'>();
    const cycles: string[] = [];

    const visit = (file: string, path: string[]): void => {
      if (state.get(file) === 'done') return;
      if (state.get(file) === 'visiting') {
        cycles.push(
          [...path.slice(path.indexOf(file)), file].map((f) => relative(SRC, f)).join(' -> '),
        );
        return;
      }
      state.set(file, 'visiting');
      for (const target of graph.get(file) ?? []) visit(target, [...path, file]);
      state.set(file, 'done');
    };

    for (const file of files) visit(file, []);
    expect(cycles).toEqual([]);
  });
});
