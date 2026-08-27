/**
 * Properties of the filesystem store that the shared contract cannot express, because they are
 * about *how* it writes rather than what it stores.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsBlobStore, sha256Of } from '../../src/infra/blob/fsBlobStore.js';

let root: string;
let store: FsBlobStore;
const body = new Uint8Array(Buffer.from('%PDF-1.4\nbody\n%%EOF\n', 'latin1'));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'juris-fs-'));
  store = new FsBlobStore({ root });
  await store.init();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FsBlobStore', () => {
  it('leaves no .part file behind after a successful write', async () => {
    await store.put('a/b/c.pdf', body, { contentType: 'application/pdf', sha256: sha256Of(body) });
    const entries = await readdir(join(root, 'a', 'b'));
    expect(entries).toContain('c.pdf');
    expect(entries.filter((e) => e.endsWith('.part'))).toEqual([]);
  });

  it('creates the nested directories a key implies', async () => {
    await store.put('x/y/z/w.pdf', body, {
      contentType: 'application/pdf',
      sha256: sha256Of(body),
    });
    expect(await readdir(join(root, 'x', 'y', 'z'))).toContain('w.pdf');
  });

  it('refuses a key that would escape the store root', async () => {
    await expect(
      store.put('../escaped.pdf', body, { contentType: 'application/pdf', sha256: 'x' }),
    ).rejects.toThrow(/outside the store root/);
    await expect(
      store.put('a/../../escaped.pdf', body, { contentType: 'application/pdf', sha256: 'x' }),
    ).rejects.toThrow(/outside the store root/);
  });

  it('reports a null hash when the sidecar is missing rather than inventing one', async () => {
    await writeFile(join(root, 'orphan.pdf'), Buffer.from(body));
    const head = await store.head('orphan.pdf');
    expect(head?.bytes).toBe(body.byteLength);
    expect(head?.sha256).toBeNull();
  });

  it('produces a file:// uri that points at the real path', () => {
    const uri = store.uri('a/b/c.pdf');
    expect(uri.startsWith('file://')).toBe(true);
    expect(decodeURIComponent(uri)).toContain('/a/b/c.pdf');
  });

  it('surfaces a read of a missing key as an error, not as empty bytes', async () => {
    await expect(store.get('does/not/exist.pdf')).rejects.toThrow();
  });
});
