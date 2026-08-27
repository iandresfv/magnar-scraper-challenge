/**
 * `BlobStore` over the local filesystem — the no-Docker path.
 *
 * The write is `.part` → `fsync` → `rename`, in that order, because a crash must never leave a
 * half-written file under a name the database believes is complete. `rename` within a
 * filesystem is atomic, and the `fsync` before it is what makes the *contents* durable rather
 * than merely the directory entry. Skipping either turns "the report says it is stored" into a
 * claim rather than a fact.
 *
 * Keys contain `/` and become directories, which is what makes the layout browsable. Every
 * segment has already been sanitised by `blobKey.ts`, and the resolved path is checked against
 * the root anyway: a store that trusts its keys is one court's odd numbering scheme away from
 * writing outside its directory.
 */
import { createHash } from 'node:crypto';
import { open, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BlobHead, BlobStore, PutResult } from '../../core/ports/blobStore.js';

export interface FsBlobStoreOptions {
  root: string;
}

export class FsBlobStore implements BlobStore {
  readonly driver = 'fs' as const;
  readonly target: string;
  private readonly root: string;

  constructor(options: FsBlobStoreOptions) {
    this.root = resolve(options.root);
    this.target = this.root;
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  uri(key: string): string {
    return pathToFileURL(this.pathFor(key)).toString();
  }

  async put(
    key: string,
    body: Uint8Array,
    meta: { contentType: string; sha256: string; tags?: Record<string, string> },
  ): Promise<PutResult> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });

    const partial = `${target}.part`;
    const handle = await open(partial, 'w');
    try {
      await handle.write(body);
      // Durability before visibility: the bytes must be on the device before the name exists.
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(partial, target);
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      throw error;
    }

    // The sidecar carries what a filesystem cannot: the hash the caller computed and the
    // content type. S3 keeps these as object metadata; here they are a small JSON file, so the
    // two backends answer `head` with the same information.
    await this.writeSidecar(target, {
      sha256: meta.sha256,
      contentType: meta.contentType,
      bytes: body.byteLength,
      ...(meta.tags ?? {}),
    });

    return { uri: this.uri(key), etag: null, bytes: body.byteLength };
  }

  async head(key: string): Promise<BlobHead | null> {
    const target = this.pathFor(key);
    try {
      const stats = await stat(target);
      return { bytes: stats.size, sha256: await this.readSidecarHash(target) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(key)));
  }

  /** Resolves a key under the root, refusing anything that escapes it. */
  private pathFor(key: string): string {
    const target = resolve(join(this.root, key));
    const rel = relative(this.root, target);
    if (rel === '' || rel.startsWith('..') || rel.startsWith(`${sep}..`)) {
      throw new Error(`blob key "${key}" resolves outside the store root`);
    }
    return target;
  }

  private async writeSidecar(target: string, meta: Record<string, unknown>): Promise<void> {
    const path = `${target}.meta.json`;
    const handle = await open(`${path}.part`, 'w');
    try {
      await handle.write(`${JSON.stringify(meta)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(`${path}.part`, path);
  }

  private async readSidecarHash(target: string): Promise<string | null> {
    try {
      const raw = await readFile(`${target}.meta.json`, 'utf8');
      const parsed = JSON.parse(raw) as { sha256?: unknown };
      return typeof parsed.sha256 === 'string' ? parsed.sha256 : null;
    } catch {
      // No sidecar: the object exists but was written by something else. Hashing it here
      // would be honest but slow; the caller falls back to comparing sizes.
      return null;
    }
  }
}

/** Hashes bytes the way both stores expect. Here so callers never invent their own. */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}
