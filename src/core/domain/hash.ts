/**
 * The content hash that makes re-running a crawl free.
 *
 * `case_record` is upserted with `WHERE content_hash IS DISTINCT FROM EXCLUDED.content_hash`, so
 * a second run over unchanged data performs zero writes, produces zero WAL and leaves
 * `updated_at` alone. That only holds if the hash is **canonical**: the same case must produce
 * the same bytes regardless of key order, and regardless of when it was scraped.
 *
 * Hence two rules:
 *   · object keys are sorted, recursively;
 *   · fields that describe *the scrape* rather than *the case* are excluded (`listedAt`,
 *     `detailedAt`, `contentHash` itself, and the leaf range, which says where we found it
 *     rather than what it is).
 */
import { createHash } from 'node:crypto';

/** Fields excluded from the hash because they describe the observation, not the case. */
const VOLATILE_FIELDS = new Set(['listedAt', 'detailedAt', 'contentHash', 'partitionId', 'ca']);

/**
 * Deterministic JSON: keys sorted, volatile fields dropped, `undefined` treated as absent.
 * Exported because the sanity checks compare canonical forms too.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (VOLATILE_FIELDS.has(key)) continue;
    const child = source[key];
    if (child === undefined) continue;
    out[key] = canonicalize(child);
  }
  return out;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Base64 of the sha256, which is the form S3's `ChecksumSHA256` header wants. */
export function sha256Base64(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('base64');
}

export function contentHashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
