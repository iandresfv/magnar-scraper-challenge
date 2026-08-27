/**
 * Composition root for sites.
 *
 * Adding a court is one line here plus a folder under `src/sites/`. That is the whole open-closed
 * claim, and the reason `test/contract/siteAdapter.contract.ts` iterates over this registry
 * rather than over a hand-written list: an adapter that is registered but does not satisfy the
 * contract fails the build.
 */
import type { SiteAdapter } from '../core/ports/siteAdapter.js';
import { createTrf5Adapter } from '../sites/br-trf5/adapter.js';

export interface SiteFactoryOptions {
  /** Overridden by the tests and by the fake server; production uses the descriptor's own. */
  baseUrl?: string;
  now?: () => Date;
}

export type SiteFactory = (options?: SiteFactoryOptions) => SiteAdapter;

const REGISTRY = new Map<string, SiteFactory>([['br-trf5', (o) => createTrf5Adapter(o ?? {})]]);

export function registerSite(id: string, factory: SiteFactory): void {
  REGISTRY.set(id, factory);
}

export function siteIds(): string[] {
  return [...REGISTRY.keys()].sort();
}

export function createSite(id: string, options: SiteFactoryOptions = {}): SiteAdapter {
  const factory = REGISTRY.get(id);
  if (factory === undefined) {
    throw new Error(`unknown site "${id}". Known sites: ${siteIds().join(', ')}`);
  }
  return factory(options);
}
